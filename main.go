package main

import (
	"crypto/tls"
	"encoding/json"
	"github.com/gorilla/websocket"
	"github.com/pion/stun"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var debug = os.Getenv("DEBUG") != ""

// timeouts / intervals
const (
	writeWait  = 10 * time.Second // deadline for write operations
	pongWait   = 30 * time.Second // wait this long for pong from client
	pingPeriod = 10 * time.Second // send ping every 10s as requested
)

type Message struct {
	Type    string  `json:"type"`
	Room    string  `json:"room"`
	Quality Quality `json:"quality"`
}

type Quality struct {
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Fps     int    `json:"fps"`
	Bitrate int    `json:"bitrate"`
	Codec   string `json:"codec"`
}

type Client struct {
	conn    *websocket.Conn
	room    string
	quality Quality
	writeMu sync.Mutex
}

var (
	rooms    = make(map[string]map[*Client]bool)
	mu       sync.Mutex
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
)

func main() {
	go stunServ()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		cleanPath := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		fp := filepath.Join("./web", cleanPath)
		if _, err := os.Stat(fp); os.IsNotExist(err) {
			fp = filepath.Join("./web", "index.html")
		}
		http.ServeFile(w, r, fp)
	})

	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/leave", handleLeave)

	srv := &http.Server{
		Addr:    ":8080",
		Handler: mux,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}

	log.Println("Web http://localhost:8080")
	log.Fatal(srv.ListenAndServe())
}

func handleLeave(w http.ResponseWriter, r *http.Request) {
	var msg Message
	err := json.NewDecoder(r.Body).Decode(&msg)
	if err != nil {
		log.Println("leave json err:", err)
		w.WriteHeader(400)
		return
	}
	if msg.Room == "" {
		w.WriteHeader(400)
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if cls, ok := rooms[msg.Room]; ok {
		for client := range cls {
			client.send(Message{Type: "leave"})
			client.conn.Close()
		}
		delete(rooms, msg.Room)
	}
	w.WriteHeader(200)
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade error:", err)
		return
	}

	// settings read deadline and pong handler
	conn.SetReadLimit(512 << 10) // 512KB limit
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(appData string) error {
		// get pong —> extend deadline
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	client := &Client{conn: conn}

	go client.pingLoop()

	go client.readPump()
}
func (c *Client) readPump() {
	defer func() {
		if debug {
			log.Printf("client disconnected: %v\n", c.conn.RemoteAddr())
		}
		c.conn.Close()
		if c.room != "" {
			mu.Lock()
			if rs, ok := rooms[c.room]; ok {
				delete(rs, c)
			}
			mu.Unlock()
		}
	}()

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if debug {
				log.Printf("read error from %v: %v\n", c.conn.RemoteAddr(), err)
			}
			break
		}

		if debug {
			log.Printf("WS in from %v: %d bytes\n", c.conn.RemoteAddr(), len(data))
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("bad json from %v: %v\n", c.conn.RemoteAddr(), err)
			continue
		}

		switch msg.Type {
		case "join":
			c.quality = msg.Quality
			c.joinRoom(msg)
			if debug {
				log.Printf("client %v joined room %s\n", c.conn.RemoteAddr(), msg.Room)
			}
			msg.Type = "joined"
			if err := c.send(msg); err != nil {
				log.Printf("failed to send joined to %v: %v\n", c.conn.RemoteAddr(), err)
			}

		case "offer", "answer", "candidate", "leave", "hangup":
			if debug {
				log.Printf("broadcasting %s from %v to room %s, bytes=%d\n",
					msg.Type, c.conn.RemoteAddr(), msg.Room, len(data))
			}
			broadcastToRoom(msg.Room, c, data)
		default:
			log.Printf("unknown type %s from %v\n", msg.Type, c.conn.RemoteAddr())
		}
	}
}

func (c *Client) send(v interface{}) error {
	data, _ := json.Marshal(v)
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.conn.SetWriteDeadline(time.Now().Add(writeWait))
	if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		return err
	}
	return nil
}

func broadcastToRoom(room string, sender *Client, data []byte) {
	mu.Lock()
	rs, ok := rooms[room]
	mu.Unlock()
	if !ok {
		log.Printf("broadcast: room %s not found\n", room)
		return
	}

	for cli := range rs {
		if cli == sender {
			continue
		}

		// use cli.writeMu to synchronize concurrent writes
		cli.writeMu.Lock()
		cli.conn.SetWriteDeadline(time.Now().Add(writeWait))
		err := cli.conn.WriteMessage(websocket.TextMessage, data)
		cli.writeMu.Unlock()
		if err != nil {
			if debug {
				log.Printf("write to %v failed: %v — removing client from room %s\n", cli.conn.RemoteAddr(), err, room)
			}
			// safe remove client
			mu.Lock()
			delete(rs, cli)
			mu.Unlock()
			// try close connect
			_ = cli.conn.Close()
		} else {
			if debug {
				log.Printf("sent %d bytes to %v (room %s)\n", len(data), cli.conn.RemoteAddr(), room)
			}
		}
	}
}

func (c *Client) joinRoom(msg Message) {
	mu.Lock()
	defer mu.Unlock()
	c.room = msg.Room
	if _, ok := rooms[msg.Room]; !ok {
		rooms[msg.Room] = make(map[*Client]bool)
	}
	rooms[msg.Room][c] = true

	// if two client -> send both "ready"
	if len(rooms[msg.Room]) == 2 {
		var quality Quality
		for cli := range rooms[msg.Room] {
			if cli.quality.Bitrate > 0 {
				quality = cli.quality
			}
		}
		for cli := range rooms[msg.Room] {
			msg.Type = "ready"
			msg.Quality = quality
			cli.send(msg)
		}
	}
}

func (c *Client) pingLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case <-ticker.C:
			c.writeMu.Lock()
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			// write control
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.writeMu.Unlock()
				// err when sending -> close
				return
			}
			c.writeMu.Unlock()
		}
	}
}

func stunServ() {
	addr := net.UDPAddr{
		Port: 3478,
		IP:   net.ParseIP("0.0.0.0"),
	}
	conn, err := net.ListenUDP("udp", &addr)
	if err != nil {
		log.Fatalf("stun start err: %v", err)
	}
	defer func(conn *net.UDPConn) {
		err := conn.Close()
		if err != nil {
			log.Println("[stun] close err:", err)
		}
	}(conn)

	log.Println("[stun] open UDP port 3478")

	buf := make([]byte, 1500)
	for {
		n, rAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			log.Printf("[stun] read err: %v", err)
			continue
		}

		// decode incoming packet into Message
		var msg stun.Message
		msg.Raw = append([]byte(nil), buf[:n]...) // copy
		if err := msg.Decode(); err != nil {
			log.Printf("[stun] not stun packet from %v: %v", rAddr, err)
			continue
		}

		if msg.Type.Method == stun.MethodBinding && msg.Type.Class == stun.ClassRequest {
			resp := stun.MustBuild(
				stun.BindingSuccess,                                   // MessageType (implements Setter)
				stun.NewTransactionIDSetter(msg.TransactionID),        // Setter that echoes TX ID
				stun.XORMappedAddress{IP: rAddr.IP, Port: rAddr.Port}, // XOR-MAPPED-ADDRESS attribute
			)

			data, err := resp.MarshalBinary()
			if err != nil {
				log.Printf("[stun] marshal resp failed: %v", err)
				continue
			}
			if _, err := conn.WriteToUDP(data, rAddr); err != nil {
				log.Printf("[stun] response write err: %v", err)
			} else {
				log.Printf("[stun] replied to %v tx=%x", rAddr, msg.TransactionID)
			}
		} else {
			log.Printf("[stun] ignored STUN message from %v: method=%v class=%v",
				rAddr, msg.Type.Method, msg.Type.Class)
		}
	}
}
