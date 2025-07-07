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
    waitingParticipants: {},
    hostId: null, // Will be set when host joins
    hostPeerId: null,
    createdAt: new Date(),
    settings: {
      requireApproval: true, // Default to requiring approval
      allowedToJoin: [], // Pre-approved participants
    },
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
    waitingCount: Object.keys(room.waitingParticipants).length,
    hasHost: !!room.hostId,
    participants: Object.values(room.participants).map((p) => ({
      username: p.username,
      joinedAt: p.joinedAt,
      isHost: p.id === room.hostId,
    })),
  });
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle joining a room
  socket.on("join-room", ({ roomId, username, peerId, isHost = false }) => {
    console.log(
      `${username} trying to join room ${roomId} with peer ID ${peerId}${
        isHost ? " as HOST" : ""
      }`
    );

    // Check if room exists
    if (!rooms[roomId]) {
      console.log(`Room ${roomId} does not exist`);
      socket.emit("room-error", { message: "Room does not exist" });
      return;
    }

    const room = rooms[roomId];
    const participantId = socket.id;

    // If this is the host (first person or explicitly marked as host)
    if (isHost || !room.hostId) {
      // Set as host
      room.hostId = participantId;
      room.hostPeerId = peerId;

      // Add host to socket room
      socket.join(roomId);

      // Store host info
      room.participants[participantId] = {
        id: participantId,
        username,
        peerId,
        socketId: socket.id,
        joinedAt: new Date(),
        audioEnabled: true,
        videoEnabled: true,
        isHost: true,
      };

      console.log(`${username} joined as HOST of room ${roomId}`);

      // Send host status to client
      socket.emit("host-status", { isHost: true });

      // Send current participants (should be empty for new host)
      socket.emit("room-participants", {
        participants: {},
      });
    } else {
      // This is a participant - add to waiting room
      room.waitingParticipants[participantId] = {
        id: participantId,
        username,
        peerId,
        socketId: socket.id,
        joinedAt: new Date(),
      };

      console.log(`${username} added to waiting room for ${roomId}`);

      // Notify participant they're in waiting room
      socket.emit("waiting-for-approval", {
        message: "Waiting for host approval to join the meeting",
      });

      // Notify host about new join request
      if (room.hostId) {
        io.to(room.hostId).emit("join-request", {
          participantId,
          username,
          peerId,
        });
      }
    }
  });

  // Handle host approving a participant
  socket.on("approve-participant", ({ roomId, participantId }) => {
    console.log(`Host approving participant: ${participantId}`);

    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) {
      socket.emit("error", { message: "Unauthorized" });
      return;
    }

    const waitingParticipant = room.waitingParticipants[participantId];
    if (!waitingParticipant) {
      return;
    }

    // Move from waiting to participants
    room.participants[participantId] = {
      ...waitingParticipant,
      audioEnabled: true,
      videoEnabled: true,
      isHost: false,
    };

    delete room.waitingParticipants[participantId];

    // Add participant to socket room
    const participantSocket = io.sockets.sockets.get(participantId);
    if (participantSocket) {
      participantSocket.join(roomId);

      // Notify participant they're approved
      participantSocket.emit("approval-granted");

      // Send current participants to the new participant
      const existingParticipants = {};
      Object.entries(room.participants).forEach(([id, participant]) => {
        if (id !== participantId) {
          existingParticipants[id] = participant;
        }
      });

      participantSocket.emit("room-participants", {
        participants: existingParticipants,
      });

      // Notify existing participants about new user
      socket.to(roomId).emit("user-joined", {
        participantId,
        username: waitingParticipant.username,
        peerId: waitingParticipant.peerId,
      });

      console.log(
        `${waitingParticipant.username} approved and joined room ${roomId}`
      );
    }
  });

  // Handle host rejecting a participant
  socket.on("reject-participant", ({ roomId, participantId }) => {
    console.log(`Host rejecting participant: ${participantId}`);

    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) {
      socket.emit("error", { message: "Unauthorized" });
      return;
    }

    const waitingParticipant = room.waitingParticipants[participantId];
    if (!waitingParticipant) {
      return;
    }

    // Remove from waiting room
    delete room.waitingParticipants[participantId];

    // Notify participant they're rejected
    const participantSocket = io.sockets.sockets.get(participantId);
    if (participantSocket) {
      participantSocket.emit("approval-rejected", {
        message: "Host denied your request to join the meeting",
      });
      participantSocket.disconnect(true);
    }

    console.log(`${waitingParticipant.username} rejected from room ${roomId}`);
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

  // Handle removing a participant (by host only)
  socket.on("remove-participant", ({ roomId, participantId, peerId }) => {
    console.log(`Removing participant: ${participantId}`);

    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) {
      socket.emit("error", { message: "Only host can remove participants" });
      return;
    }

    if (room.participants[participantId]) {
      // Notify the participant they're being removed
      io.to(participantId).emit("you-were-removed");

      // Notify other participants
      socket.to(roomId).emit("user-removed", {
        participantId,
        peerId,
      });

      // Remove from room data
      delete room.participants[participantId];

      // Force disconnect the removed user
      io.sockets.sockets.get(participantId)?.disconnect(true);
    }
  });

  // Handle getting waiting participants (host only)
  socket.on("get-waiting-participants", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) {
      return;
    }

    socket.emit("waiting-participants", {
      participants: Object.values(room.waitingParticipants),
    });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    // Find which room this user was in
    for (const roomId in rooms) {
      const room = rooms[roomId];

      // Check if disconnected user was in participants
      if (room.participants[socket.id]) {
        const participant = room.participants[socket.id];
        console.log(`${participant.username} left room ${roomId}`);

        // If host disconnected, notify all participants
        if (room.hostId === socket.id) {
          console.log(`Host left room ${roomId}`);
          io.to(roomId).emit("host-left");

          // You could implement host transfer logic here
          // For now, we'll just clear the host
          room.hostId = null;
          room.hostPeerId = null;
        } else {
          // Regular participant left
          socket.to(roomId).emit("user-left", {
            participantId: socket.id,
            peerId: participant.peerId,
          });
        }

        delete room.participants[socket.id];
      }

      // Check if disconnected user was in waiting room
      if (room.waitingParticipants[socket.id]) {
        delete room.waitingParticipants[socket.id];
      }

      // Clean up empty rooms
      if (
        Object.keys(room.participants).length === 0 &&
        Object.keys(room.waitingParticipants).length === 0
      ) {
        setTimeout(() => {
          if (
            rooms[roomId] &&
            Object.keys(rooms[roomId].participants).length === 0 &&
            Object.keys(rooms[roomId].waitingParticipants).length === 0
          ) {
            delete rooms[roomId];
            console.log(`Room ${roomId} has been removed due to inactivity`);
          }
        }, 60000);
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
    const room = rooms[roomId];
    roomSummary[roomId] = {
      participantCount: Object.keys(room.participants).length,
      waitingCount: Object.keys(room.waitingParticipants).length,
      hostId: room.hostId,
      participants: Object.values(room.participants).map((p) => ({
        username: p.username,
        peerId: p.peerId,
        isHost: p.isHost,
        joinedAt: p.joinedAt,
      })),
      waitingParticipants: Object.values(room.waitingParticipants).map((p) => ({
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
