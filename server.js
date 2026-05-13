const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

io.on("connection", (socket) => {

  console.log("Player connected");

  socket.on("draw-number", (number) => {

    io.emit("new-number", number);

  });

  socket.on("disconnect", () => {

    console.log("Disconnected");

  });

});

server.listen(3000, () => {
  console.log("Server started");
});