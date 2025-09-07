const express = require("express");
const cors = require("cors");
const { Ollama } = require("ollama");

const app = express();

app.use(express.json());

const corsOptions = {
  origin: ["http://localhost:3000", "http://localhost:5000"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use((req, res, next) => {
  console.log("Before CORS Middleware");
  next();
});

app.use(cors(corsOptions));

app.options("*", (req, res) => {
  console.log("Preflight Request Detected");
  res.header("Access-Control-Allow-Origin", "http://localhost:3000");
  res.header("Access-Control-Allow-Credentials", "true");
  res.status(200).end();
});

app.use((req, res, next) => {
  console.log("CORS Middleware");
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

const ollama = new Ollama({ host: "http://100.64.0.1:11434" });

app.post("/quiz", async (req, res) => {
  try {
    const requestData = req.body;

    console.log("Reuest data:", requestData);

    const response = await ollama.chat({
      model: requestData.model || "gpt-oss:120b",
      messages: requestData.messages,
      stream: false,
    });

    res.json(response);
  } catch (error) {
    console.error("Error proxying to golem:", error);
    res.status(500).json({ error: "Failed to fetch from golem" });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
