const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Store active rooms and participants
const rooms = {};

// API endpoint to create a new room
app.post("/api/room", (req, res) => {
  const roomId = uuidv4();
  rooms[roomId] = {
    id: roomId,
    participants: {},
    createdAt: new Date(),
  };
  console.log(`Created room: ${roomId}`);
  res.json({ roomId });
});

// Get room info
app.get("/api/room/:roomId", (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({
    roomId: room.id,
    participantCount: Object.keys(room.participants).length,
    participants: Object.values(room.participants).map((p) => ({
      username: p.username,
      joinedAt: p.joinedAt,
    })),
  });
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle joining a room
  socket.on("join-room", ({ roomId, username, peerId }) => {
    console.log(
      `${username} trying to join room ${roomId} with peer ID ${peerId}`
    );

    // Check if room exists
    if (!rooms[roomId]) {
      console.log(`Room ${roomId} does not exist`);
      socket.emit("room-error", { message: "Room does not exist" });
      return;
    }

    // Add user to socket room
    socket.join(roomId);

    // Store participant info
    const participantId = socket.id;
    rooms[roomId].participants[participantId] = {
      id: participantId,
      username,
      peerId,
      socketId: socket.id,
      joinedAt: new Date(),
      audioEnabled: true,
      videoEnabled: true,
    };

    console.log(
      `${username} joined room ${roomId}. Total participants: ${
        Object.keys(rooms[roomId].participants).length
      }`
    );

    // Notify existing participants about the new user
    socket.to(roomId).emit("user-joined", {
      participantId,
      username,
      peerId,
    });

    // Send current participants to the new user
    const existingParticipants = {};
    Object.entries(rooms[roomId].participants).forEach(([id, participant]) => {
      if (id !== participantId) {
        existingParticipants[id] = participant;
      }
    });

    socket.emit("room-participants", {
      participants: existingParticipants,
    });

    console.log(
      `Sent ${
        Object.keys(existingParticipants).length
      } existing participants to ${username}`
    );
  });

  // Handle user muting/unmuting audio
  socket.on("toggle-audio", ({ roomId, peerId, enabled }) => {
    console.log(`Audio toggle: ${socket.id} - ${enabled}`);

    if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
      rooms[roomId].participants[socket.id].audioEnabled = enabled;

      // Notify other participants
      socket.to(roomId).emit("user-toggle-audio", {
        participantId: socket.id,
        peerId,
        enabled,
      });
    }
  });

  // Handle user muting/unmuting video
  socket.on("toggle-video", ({ roomId, peerId, enabled }) => {
    console.log(`Video toggle: ${socket.id} - ${enabled}`);

    if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
      rooms[roomId].participants[socket.id].videoEnabled = enabled;

      // Notify other participants
      socket.to(roomId).emit("user-toggle-video", {
        participantId: socket.id,
        peerId,
        enabled,
      });
    }
  });

  // Handle removing a participant (by admin)
  socket.on("remove-participant", ({ roomId, participantId, peerId }) => {
    console.log(`Removing participant: ${participantId}`);

    if (rooms[roomId] && rooms[roomId].participants[participantId]) {
      // Notify the participant they're being removed
      io.to(participantId).emit("you-were-removed");

      // Notify other participants
      socket.to(roomId).emit("user-removed", {
        participantId,
        peerId,
      });

      // Remove from room data
      delete rooms[roomId].participants[participantId];

      // Force disconnect the removed user
      io.sockets.sockets.get(participantId)?.disconnect(true);
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    // Find which room this user was in
    for (const roomId in rooms) {
      if (rooms[roomId].participants[socket.id]) {
        const participant = rooms[roomId].participants[socket.id];

        console.log(`${participant.username} left room ${roomId}`);

        // Notify other participants
        socket.to(roomId).emit("user-left", {
          participantId: socket.id,
          peerId: participant.peerId,
        });

        // Remove from room data
        delete rooms[roomId].participants[socket.id];

        console.log(
          `Room ${roomId} now has ${
            Object.keys(rooms[roomId].participants).length
          } participants`
        );

        // If room is empty, remove it after a delay
        if (Object.keys(rooms[roomId].participants).length === 0) {
          setTimeout(() => {
            if (
              rooms[roomId] &&
              Object.keys(rooms[roomId].participants).length === 0
            ) {
              delete rooms[roomId];
              console.log(`Room ${roomId} has been removed due to inactivity`);
            }
          }, 60000); // Remove after 1 minute of inactivity
        }

        break;
      }
    }
  });

  // Handle ping for connection testing
  socket.on("ping", (callback) => {
    callback("pong");
  });
});

// Debug endpoint to see all rooms
app.get("/api/debug/rooms", (req, res) => {
  const roomSummary = {};
  Object.keys(rooms).forEach((roomId) => {
    roomSummary[roomId] = {
      participantCount: Object.keys(rooms[roomId].participants).length,
      participants: Object.values(rooms[roomId].participants).map((p) => ({
        username: p.username,
        peerId: p.peerId,
        joinedAt: p.joinedAt,
      })),
    };
  });
  res.json(roomSummary);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Debug endpoint: http://localhost:${PORT}/api/debug/rooms`);
});
