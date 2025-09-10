package main

import (
	"github.com/pion/stun"
	"log"
	"net"
)

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
				if debug {
					log.Printf("[stun] replied to %v tx=%x", rAddr, msg.TransactionID)
				}
			}
		} else {
			log.Printf("[stun] ignored STUN message from %v: method=%v class=%v",
				rAddr, msg.Type.Method, msg.Type.Class)
		}
	}
}
