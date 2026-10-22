const { createServer } = require("http");
const { Server } = require("socket.io");

const http = createServer((req, res) => res.end("ok"));

const io = new Server(http, {
  cors: {
    origin: [
      "https://aldairfrancaneto.github.io",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
    ],
  },
});

io.on("connection", (socket) => {
  socket.on("entrar", ({ sala, nome }) => {
    socket.join(sala);
    socket.data = { sala, nome };
    io.to(sala).emit("aviso", `${nome} entrou`);
  });

  socket.on("jogada", (dados) => {
    if (!socket.data.sala) return;
    socket.to(socket.data.sala).emit("jogada", { de: socket.data.nome, ...dados });
  });

  socket.on("disconnect", () => {
    if (socket.data.sala) io.to(socket.data.sala).emit("aviso", `${socket.data.nome} saiu`);
  });
});

http.listen(process.env.PORT || 3000, () => console.log("Servidor no ar"));
