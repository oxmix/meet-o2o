package main

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/gorilla/websocket"
	"log"
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
	pongWait   = 30 * time.Second // wait this long for pong from viewer
	pingPeriod = 10 * time.Second // send ping every 10s as requested
)

type Room struct {
	name       string
	creator    *Client
	viewer     *Client
	viewerLeft bool
	quality    Quality
}

type Client struct {
	id      string
	conn    *websocket.Conn
	writeMu sync.Mutex
	room    *Room
}

var (
	mu       sync.Mutex
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
	rooms = make(map[string]*Room)
)

func newId() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type Message struct {
	Type    string  `json:"type"`
	Room    string  `json:"room"`
	Quality Quality `json:"quality"`
	Text    string  `json:"text"`
}

type Quality struct {
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Fps     int    `json:"fps"`
	Bitrate int    `json:"bitrate"`
	Codec   string `json:"codec"`
}

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

	log.Println("[o2o] web http://localhost:8080")
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
	if room, ok := rooms[msg.Room]; ok {
		if msg.Type == "creator" {
			if room.viewer != nil {
				room.viewer.send(Message{Type: "leave"})
				room.viewer.conn.Close()
				room.viewer = nil
			}
			room.creator.conn.Close()
			delete(rooms, msg.Room)
			log.Printf("[o2o][%s] creator destroyed room, initiator: event", msg.Room)
		}
		if msg.Type == "viewer" && room.viewer != nil {
			// do nothing otherwise damage already connection
		}
	}
	w.WriteHeader(200)
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("[o2o] upgrade error:", err)
		return
	}

	id := r.URL.Query().Get("id")
	if id == "" {
		id = newId()
	}

	client := &Client{
		id:      id,
		conn:    conn,
		writeMu: sync.Mutex{},
	}

	// setup read/pong etc
	conn.SetReadLimit(512 << 10)
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(appData string) error {
		// get pong —> extend deadline
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	go client.pingLoop()
	go client.readPump()
}

func (c *Client) readPump() {
	defer func() {
		c.conn.Close()
		if c.room == nil {
			return
		}
		log.Printf("[o2o][%s] disconnected: %v", c.room.name, c.conn.RemoteAddr())
		mu.Lock()
		defer mu.Unlock()
		if rs, ok := rooms[c.room.name]; ok {
			if rs.creator == c {
				if rs.viewer != nil {
					rs.viewer.send(Message{Type: "leave", Room: c.room.name})
				}
				delete(rooms, c.room.name)
				log.Printf("[o2o][%s] creator destroyed room, initiator: disconnected", c.room.name)
			}
			if rs.viewer == c {
				log.Printf("[o2o][%s] viewer left", c.room.name)
				rs.viewerLeft = true
				rs.viewer = nil
			}
		}
	}()

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if debug {
				log.Printf("[o2o] read error from %v: %v", c.conn.RemoteAddr(), err)
			}
			break
		}

		if debug {
			log.Printf("[o2o] ws in from %v: %d bytes", c.conn.RemoteAddr(), len(data))
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("[o2o] bad json from %v: %v", c.conn.RemoteAddr(), err)
			continue
		}

		switch msg.Type {
		case "join":
			err = c.joinRoom(msg)
			if err != nil {
				msg.Type = "error"
				msg.Text = err.Error()
				_ = c.send(msg)
				return
			}
			msg.Type = "joined"
			_ = c.send(msg)
		case "offer", "answer", "candidate", "leave", "hangup", "state":
			if debug {
				log.Printf("[o2o] broadcasting %s from %v to room %s, bytes=%d",
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
		log.Printf("[o2o] broadcast: room %q not found", room)
		return
	}

	if rs.creator == nil || rs.viewer == nil {
		return
	}

	to := rs.creator
	if sender == rs.creator {
		to = rs.viewer
	}

	to.writeMu.Lock()
	to.conn.SetWriteDeadline(time.Now().Add(writeWait))
	err := to.conn.WriteMessage(websocket.TextMessage, data)
	to.writeMu.Unlock()
	if err != nil {
		if debug {
			log.Printf("[o2o][%s] write to %v failed: %v — removing client from room",
				room, to.conn.RemoteAddr(), err)
		}
		_ = to.conn.Close()
		mu.Lock()
		defer mu.Unlock()
		if rc, ok := rooms[room]; ok {
			if rc.creator == to {
				rc.creator = nil
			}
			if rc.viewer == to {
				rc.viewer = nil
			}
			if rc.creator == nil && rc.viewer == nil {
				delete(rooms, room)
				log.Printf("[o2o][%s] creator destroyed room, initiator: err write", room)
			}
		}
	}
}

func (c *Client) joinRoom(msg Message) error {
	mu.Lock()
	defer mu.Unlock()

	room, ok := rooms[msg.Room]
	if !ok {
		if msg.Quality.Bitrate <= 0 {
			return errors.New("you not creator")
		}
		rooms[msg.Room] = &Room{
			creator: c,
			quality: msg.Quality,
		}
		room = rooms[msg.Room]
		c.room = room
		log.Printf("[o2o][%s] creator join room: %s", msg.Room, c.conn.RemoteAddr())
	} else {
		if room.viewer != nil {
			return errors.New("room busy")
		}
		if room.creator == nil {
			return errors.New("creator not yet joined")
		}
		room.viewer = c
		c.room = room
		log.Printf("[o2o][%s] viewer join room: %s", msg.Room, c.conn.RemoteAddr())

		if c.room.viewerLeft {
			log.Printf("[o2o][%s] signal peer viewer replaced", msg.Room)
			room.creator.send(Message{Type: "peer-replaced", Room: msg.Room})
		}
	}
	c.room.name = msg.Room

	if room.creator != nil && room.viewer != nil {
		msg.Type = "ready"
		msg.Quality = room.quality

		if !c.room.viewerLeft {
			room.creator.send(msg)
		}
		room.viewer.send(msg)
	}
	return nil
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
