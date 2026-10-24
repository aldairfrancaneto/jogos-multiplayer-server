const { createServer } = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

/* ============================================================
   Servidor de salas dos jogos (Health Education Studio)

   Modelo "lockstep": o servidor é o dono da ordem das jogadas.
   - O professor cria a sala e recebe um código curto (ex.: 4K7P).
   - As equipes entram com o código e ganham um lugar (seat 0..3)
     e um token para voltar ao mesmo lugar se a conexão cair.
   - Ao iniciar, o servidor sorteia a semente (seed) da partida.
   - Toda jogada passa pelo servidor, ganha um número de ordem
     (seq) e é repassada a TODOS da sala, inclusive a quem jogou.
   - Como todos usam a mesma semente e aplicam as mesmas jogadas
     na mesma ordem, todos os tabuleiros ficam iguais.
   - Quem reconecta recebe a semente + o registro de jogadas e
     refaz a partida até o ponto atual.

   Estado só em memória: se o Render reiniciar, as salas somem.
   ============================================================ */

const http = createServer((req, res) => res.end("ok"));
// v2.1 (24/out/2026): jogo "uninogwarts" (dupla de aventura) e o repasse "eco"

const io = new Server(http, {
  cors: {
    origin: [
      "https://aldairfrancaneto.github.io",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
    ],
  },
  maxHttpBufferSize: 64 * 1024,
});

/* ---------- limites ---------- */
const MAX_SALAS = 200;
const MAX_JOGADAS = 5000;          // por partida
const MAX_DADOS = 2000;            // tamanho (JSON) de uma jogada
const MAX_PLACAR = 4000;           // tamanho (JSON) do placar
const SALA_OCIOSA_MS = 6 * 60 * 60 * 1000;   // apaga sala parada há 6 h

/* ---------- jogos conhecidos ---------- */
// min/max de equipes e os tipos de jogada aceitos (null = qualquer tipo)
// privados: tipos de jogada que só o professor e a própria equipe recebem (os
//           outros recebem a jogada sem os dados, para a numeração seguir contínua)
// maxDados: tamanho máximo de uma jogada nesse jogo (padrão MAX_DADOS)
const JOGOS = {
  morte: { min: 2, max: 4, tipos: null },
  aterosclerose: { min: 2, max: 4, tipos: null },
  ampulheta: { min: 2, max: 4, tipos: null },
  hallmarks: { min: 2, max: 4, tipos: null },
  lesoes: { min: 2, max: 4, tipos: null },
  organelas: { min: 2, max: 4, tipos: null },
  pielonefrite: { min: 2, max: 4, tipos: null },
  replicacao: { min: 2, max: 4, tipos: null },
  investigacao: { min: 1, max: 12, tipos: null, privados: ["resp"], maxDados: 6000 },
  uninogwarts: { min: 1, max: 1, tipos: null, eco: 60000 },   // dupla de aventura: quem cria a sala + 1 amigo
  teste: { min: 1, max: 4, tipos: null },
};

const salas = new Map();   // codigo -> sala

/* ---------- utilitários ---------- */
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // sem 0/O, 1/I/L
function novoCodigo() {
  for (let t = 0; t < 1000; t++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += ALFABETO[crypto.randomInt(ALFABETO.length)];
    if (!salas.has(c)) return c;
  }
  return null;
}
const novoToken = () => crypto.randomBytes(12).toString("hex");
const limparNome = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 24);
const normCodigo = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
function tamanhoJson(x) {
  try { return JSON.stringify(x === undefined ? null : x).length; } catch (e) { return Infinity; }
}
function responder(ack, dados) { if (typeof ack === "function") ack(dados); }

/* o que todo mundo da sala pode ver (sem tokens) */
function vistaSala(sala) {
  return {
    codigo: sala.codigo,
    jogo: sala.jogo,
    status: sala.status,              // 'lobby' | 'jogo' | 'fim'
    max: sala.max,
    config: sala.config,
    professorOnline: !!sala.profSocket,
    equipes: sala.equipes.map((e) => ({ seat: e.seat, nome: e.nome, online: !!e.socketId })),
    jogadas: sala.log.length,
  };
}
function avisarSala(sala) { io.to(sala.codigo).emit("sala", vistaSala(sala)); }

/* jogada privada vista por quem não é o professor nem a equipe autora */
const ocultar = (j) => ({ seq: j.seq, seat: j.seat, tipo: j.tipo, dados: null, oculto: true });
/* o registro de jogadas que um aparelho pode ver (seat = null → professor, vê tudo) */
function logPara(sala, seat, desde) {
  const log = desde ? sala.log.slice(desde) : sala.log;
  if (seat == null) return log;
  return log.map((j) => (j.privada && j.seat !== seat ? ocultar(j) : j));
}
const seatDe = (socket) => (socket.data.papel === "prof" ? null : socket.data.seat);

/* tudo que um aparelho precisa para refazer a partida (seat = null → professor) */
function pacotePartida(sala, seat) {
  return {
    seed: sala.seed,
    jogadores: sala.jogadores,        // nomes na ordem dos lugares fixada no início
    config: sala.config,
    log: logPara(sala, seat),
    placar: sala.placar,
  };
}

function tocar(sala) { sala.ultimoUso = Date.now(); }

/* ---------- conexões ---------- */
io.on("connection", (socket) => {
  socket.data = {};   // { codigo, papel: 'prof' | 'equipe', seat }

  // aceita emit("evento", dados, ack), emit("evento", ack) e dados nulos
  const on = (evento, fn) => socket.on(evento, (a, b) =>
    typeof a === "function" ? fn({}, a) : fn(a && typeof a === "object" ? a : {}, b));

  function salaAtual() {
    const s = socket.data.codigo && salas.get(socket.data.codigo);
    return s || null;
  }

  function sairDaSalaAtual() {
    const sala = salaAtual();
    if (!sala) return;
    socket.leave(sala.codigo);
    if (socket.data.papel === "prof" && sala.profSocket === socket.id) sala.profSocket = null;
    if (socket.data.papel === "equipe") {
      const e = sala.equipes.find((x) => x.seat === socket.data.seat);
      if (e && e.socketId === socket.id) e.socketId = null;
    }
    socket.data = {};
    avisarSala(sala);
  }

  /* ----- professor ----- */

  on("prof:criar", ({ jogo, max, config } = {}, ack) => {
    const def = JOGOS[jogo];
    if (!def) return responder(ack, { ok: false, erro: "Jogo desconhecido." });
    if (salas.size >= MAX_SALAS) return responder(ack, { ok: false, erro: "Servidor cheio. Tente mais tarde." });
    if (tamanhoJson(config) > MAX_DADOS) return responder(ack, { ok: false, erro: "Configuração grande demais." });
    const codigo = novoCodigo();
    if (!codigo) return responder(ack, { ok: false, erro: "Não consegui gerar um código." });

    sairDaSalaAtual();
    const sala = {
      codigo,
      jogo,
      max: Math.min(def.max, Math.max(def.min, Number(max) || def.max)),
      config: config === undefined ? null : config,
      status: "lobby",
      profToken: novoToken(),
      profSocket: socket.id,
      equipes: [],          // { seat, nome, token, socketId }
      jogadores: [],
      seed: null,
      log: [],
      placar: null,
      ultimoUso: Date.now(),
    };
    salas.set(codigo, sala);
    socket.join(codigo);
    socket.data = { codigo, papel: "prof" };
    responder(ack, { ok: true, codigo, token: sala.profToken, sala: vistaSala(sala) });
    avisarSala(sala);
  });

  // professor recarregou a página ou trocou de aparelho
  on("prof:retomar", ({ codigo, token } = {}, ack) => {
    const sala = salas.get(normCodigo(codigo));
    if (!sala || sala.profToken !== token) return responder(ack, { ok: false, erro: "Sala não encontrada." });
    sairDaSalaAtual();
    sala.profSocket = socket.id;
    socket.join(sala.codigo);
    socket.data = { codigo: sala.codigo, papel: "prof" };
    tocar(sala);
    responder(ack, {
      ok: true,
      sala: vistaSala(sala),
      partida: sala.status === "lobby" ? null : pacotePartida(sala, null),
    });
    avisarSala(sala);
  });

  on("prof:config", ({ config } = {}, ack) => {
    const sala = salaAtual();
    if (!sala || socket.data.papel !== "prof") return responder(ack, { ok: false, erro: "Sem permissão." });
    if (sala.status !== "lobby") return responder(ack, { ok: false, erro: "A partida já começou." });
    if (tamanhoJson(config) > MAX_DADOS) return responder(ack, { ok: false, erro: "Configuração grande demais." });
    sala.config = config === undefined ? null : config;
    tocar(sala);
    responder(ack, { ok: true });
    avisarSala(sala);
  });

  on("prof:remover", ({ seat } = {}, ack) => {
    const sala = salaAtual();
    if (!sala || socket.data.papel !== "prof") return responder(ack, { ok: false, erro: "Sem permissão." });
    if (sala.status !== "lobby") return responder(ack, { ok: false, erro: "Só dá para remover antes de iniciar." });
    const i = sala.equipes.findIndex((e) => e.seat === Number(seat));
    if (i < 0) return responder(ack, { ok: false, erro: "Equipe não encontrada." });
    const [e] = sala.equipes.splice(i, 1);
    if (e.socketId) {
      const s = io.sockets.sockets.get(e.socketId);
      if (s) { s.emit("removido"); s.leave(sala.codigo); s.data = {}; }
    }
    tocar(sala);
    responder(ack, { ok: true });
    avisarSala(sala);
  });

  on("prof:iniciar", (_, ack) => {
    const sala = salaAtual();
    if (!sala || socket.data.papel !== "prof") return responder(ack, { ok: false, erro: "Sem permissão." });
    if (sala.status === "jogo") return responder(ack, { ok: false, erro: "A partida já começou." });
    const def = JOGOS[sala.jogo];
    if (sala.equipes.length < def.min)
      return responder(ack, { ok: false, erro: `São precisas pelo menos ${def.min} equipes.` });

    // lugares renumerados 0..n-1 na ordem de chegada
    sala.equipes.sort((a, b) => a.seat - b.seat).forEach((e, i) => {
      e.seat = i;
      const s = e.socketId && io.sockets.sockets.get(e.socketId);
      if (s) s.data.seat = i;
    });
    sala.jogadores = sala.equipes.map((e) => e.nome);
    sala.seed = crypto.randomInt(1, 2147483647);
    sala.log = [];
    sala.placar = null;
    sala.status = "jogo";
    tocar(sala);
    responder(ack, { ok: true });
    // cada equipe recebe o próprio lugar (pode ter mudado na renumeração)
    sala.equipes.forEach((e) => {
      if (e.socketId) io.to(e.socketId).emit("seu-lugar", { seat: e.seat });
    });
    io.to(sala.codigo).emit("inicio", pacotePartida(sala, null));   // registro vazio: igual para todos
    avisarSala(sala);
  });

  // nova partida com as mesmas equipes
  on("prof:reiniciar", (_, ack) => {
    const sala = salaAtual();
    if (!sala || socket.data.papel !== "prof") return responder(ack, { ok: false, erro: "Sem permissão." });
    sala.status = "lobby";
    sala.seed = null;
    sala.log = [];
    sala.placar = null;
    tocar(sala);
    responder(ack, { ok: true });
    io.to(sala.codigo).emit("lobby");
    avisarSala(sala);
  });

  on("prof:encerrar", (_, ack) => {
    const sala = salaAtual();
    if (!sala || socket.data.papel !== "prof") return responder(ack, { ok: false, erro: "Sem permissão." });
    sala.status = "fim";
    tocar(sala);
    responder(ack, { ok: true });
    io.to(sala.codigo).emit("fim", { placar: sala.placar });
    avisarSala(sala);
  });

  on("prof:fechar", (_, ack) => {
    const sala = salaAtual();
    if (!sala || socket.data.papel !== "prof") return responder(ack, { ok: false, erro: "Sem permissão." });
    io.to(sala.codigo).emit("sala-fechada");
    io.in(sala.codigo).socketsLeave(sala.codigo);
    salas.delete(sala.codigo);
    socket.data = {};
    responder(ack, { ok: true });
  });

  // o aparelho do professor calcula o placar (roda o mesmo motor) e o guarda aqui
  socket.on("placar", (placar, ack) => {
    const sala = salaAtual();
    if (!sala || socket.data.papel !== "prof") return responder(ack, { ok: false });
    if (tamanhoJson(placar) > MAX_PLACAR) return responder(ack, { ok: false, erro: "Placar grande demais." });
    sala.placar = placar;
    tocar(sala);
    responder(ack, { ok: true });
    socket.to(sala.codigo).emit("placar", placar);
  });

  /* ----- equipes ----- */

  on("aluno:entrar", ({ codigo, nome, token } = {}, ack) => {
    const sala = salas.get(normCodigo(codigo));
    if (!sala) return responder(ack, { ok: false, erro: "Código não encontrado. Confira com o professor." });
    nome = limparNome(nome);

    // 1) volta pelo token (mesmo aparelho)
    let e = token && sala.equipes.find((x) => x.token === token);
    // 2) partida em andamento: volta pelo nome, se aquela equipe estiver desconectada
    if (!e && sala.status !== "lobby" && nome) {
      e = sala.equipes.find((x) => !x.socketId && x.nome.toLowerCase() === nome.toLowerCase());
    }
    if (!e) {
      if (sala.status !== "lobby") return responder(ack, { ok: false, erro: "A partida já começou." });
      if (!nome) return responder(ack, { ok: false, erro: "Digite o nome da equipe." });
      if (sala.equipes.length >= sala.max) return responder(ack, { ok: false, erro: "A sala está cheia." });
      if (sala.equipes.some((x) => x.nome.toLowerCase() === nome.toLowerCase()))
        return responder(ack, { ok: false, erro: "Já existe uma equipe com esse nome." });
      const seat = sala.equipes.reduce((m, x) => Math.max(m, x.seat + 1), 0);
      e = { seat, nome, token: novoToken(), socketId: null };
      sala.equipes.push(e);
    }

    // derruba a conexão antiga da mesma equipe (ex.: aba duplicada)
    if (e.socketId && e.socketId !== socket.id) {
      const velho = io.sockets.sockets.get(e.socketId);
      if (velho) { velho.emit("substituido"); velho.leave(sala.codigo); velho.data = {}; }
    }
    sairDaSalaAtual();
    e.socketId = socket.id;
    socket.join(sala.codigo);
    socket.data = { codigo: sala.codigo, papel: "equipe", seat: e.seat };
    tocar(sala);
    responder(ack, {
      ok: true,
      seat: e.seat,
      nome: e.nome,
      token: e.token,
      sala: vistaSala(sala),
      partida: sala.status === "lobby" ? null : pacotePartida(sala, e.seat),
    });
    avisarSala(sala);
  });

  /* ----- jogadas (equipes e professor) ----- */

  // { tipo, dados } -> todos recebem { seq, seat, tipo, dados }
  // seat = -1 quando quem jogou foi o professor
  on("acao", ({ tipo, dados } = {}, ack) => {
    const sala = salaAtual();
    if (!sala) return responder(ack, { ok: false, erro: "Fora da sala." });
    if (sala.status !== "jogo") return responder(ack, { ok: false, erro: "A partida não está em andamento." });
    if (typeof tipo !== "string" || !tipo || tipo.length > 40) return responder(ack, { ok: false, erro: "Jogada inválida." });
    const def = JOGOS[sala.jogo];
    if (def.tipos && !def.tipos.includes(tipo)) return responder(ack, { ok: false, erro: "Jogada desconhecida." });
    if (tamanhoJson(dados) > (def.maxDados || MAX_DADOS)) return responder(ack, { ok: false, erro: "Jogada grande demais." });
    if (sala.log.length >= MAX_JOGADAS) return responder(ack, { ok: false, erro: "Limite de jogadas da partida." });

    const jogada = {
      seq: sala.log.length,
      seat: socket.data.papel === "prof" ? -1 : socket.data.seat,
      tipo,
      dados: dados === undefined ? null : dados,
    };
    const privada = !!(def.privados && def.privados.includes(tipo) && jogada.seat !== -1);
    if (privada) Object.defineProperty(jogada, "privada", { value: true, enumerable: false });
    sala.log.push(jogada);
    tocar(sala);
    responder(ack, { ok: true, seq: jogada.seq });
    if (!privada) { io.to(sala.codigo).emit("acao", jogada); return; }
    // privada: completa só para o professor e a equipe autora; os demais recebem sem os dados
    if (sala.profSocket) io.to(sala.profSocket).emit("acao", jogada);
    sala.equipes.forEach((e) => {
      if (e.socketId) io.to(e.socketId).emit("acao", e.seat === jogada.seat ? jogada : ocultar(jogada));
    });
  });

  // aparelho percebeu que pulou alguma jogada: pede o que falta
  on("sync", ({ desde } = {}, ack) => {
    const sala = salaAtual();
    if (!sala) return responder(ack, { ok: false, erro: "Fora da sala." });
    if (sala.status === "lobby") return responder(ack, { ok: true, partida: null });
    const d = Math.max(0, Number(desde) || 0);
    responder(ack, { ok: true, seed: sala.seed, jogadores: sala.jogadores, config: sala.config, log: logPara(sala, seatDe(socket), d), desde: d });
  });

  /* ----- eco: repasse direto, sem registro (jogos em tempo real) -----
     Para o que muda o tempo todo (posição dos personagens, relógio, imagem do simulador): o servidor só
     entrega aos OUTROS aparelhos da sala, sem guardar nada e sem numerar. Só nos jogos com "eco" no JOGOS
     (o número é o tamanho máximo de uma mensagem). */
  socket.on("eco", (dados) => {
    const sala = salaAtual();
    if (!sala) return;
    const lim = JOGOS[sala.jogo] && JOGOS[sala.jogo].eco;
    if (!lim || tamanhoJson(dados) > lim) return;
    tocar(sala);
    socket.to(sala.codigo).emit("eco", { seat: socket.data.papel === "prof" ? -1 : socket.data.seat, dados });
  });

  /* ----- protocolo antigo (teste-multiplayer.html) ----- */

  socket.on("entrar", ({ sala, nome } = {}) => {
    if (typeof sala !== "string") return;
    socket.join(sala);
    socket.data.antiga = { sala, nome: limparNome(nome) };
    io.to(sala).emit("aviso", `${socket.data.antiga.nome} entrou`);
  });

  socket.on("jogada", (dados) => {
    const a = socket.data.antiga;
    if (!a) return;
    socket.to(a.sala).emit("jogada", { de: a.nome, ...dados });
  });

  /* ----- saída ----- */

  socket.on("disconnect", () => {
    if (socket.data.antiga) io.to(socket.data.antiga.sala).emit("aviso", `${socket.data.antiga.nome} saiu`);
    const sala = salaAtual();
    if (!sala) return;
    if (socket.data.papel === "prof" && sala.profSocket === socket.id) sala.profSocket = null;
    if (socket.data.papel === "equipe") {
      const e = sala.equipes.find((x) => x.seat === socket.data.seat);
      if (e && e.socketId === socket.id) e.socketId = null;
      // no lobby, quem sai libera o lugar
      if (sala.status === "lobby" && e && !e.socketId) {
        sala.equipes = sala.equipes.filter((x) => x !== e);
      }
    }
    avisarSala(sala);
  });
});

/* apaga salas paradas */
setInterval(() => {
  const agora = Date.now();
  for (const [codigo, sala] of salas) {
    const alguem = sala.profSocket || sala.equipes.some((e) => e.socketId);
    if (!alguem && agora - sala.ultimoUso > SALA_OCIOSA_MS) salas.delete(codigo);
  }
}, 10 * 60 * 1000);

http.listen(process.env.PORT || 3000, () => console.log("Servidor no ar"));
