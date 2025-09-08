const express = require("express");
const cors = require("cors");
const { Ollama } = require("ollama");
const util = require("util");

const API_KEY = process.env.API_KEY;
const BASE_URL = "https://domainr.p.rapidapi.com/v2";
console.log(API_KEY);

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

const searchDomainToolSchema = {
  type: "function",
  function: {
    name: "searchDomains",
    description:
      "Returns domain name suggestions and variations based on a given query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search term or keyword for domain suggestions (e.g., 'acme cafe').",
        },
      },
      required: ["query"],
    },
  },
};

const getDomainStatusToolSchema = {
  type: "function",
  function: {
    name: "getDomainStatus",
    description: "Checks the availability and status of a given domain name.",
    parameters: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description:
            "The fully qualified domain name to check (e.g., 'acmecoffee.shop').",
        },
      },
      required: ["domain"],
    },
  },
};
async function searchDomains(query) {
  const url = `https://domainr.p.rapidapi.com/v2/search?query=${encodeURIComponent(
    query
  )}`;
  const response = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": API_KEY,
      "X-RapidAPI-Host": "domainr.p.rapidapi.com",
    },
  });
  console.log("searching");
  if (!response.ok) {
    throw new Error(
      `Error fetching search results: ${response.status} ${response.statusText}`
    );
  }
  return response.json();
}

async function getDomainStatus(domain) {
  const url = `${BASE_URL}/status?domain=${encodeURIComponent(domain)}`;

  const response = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": API_KEY,
      "X-RapidAPI-Host": "domainr.p.rapidapi.com",
    },
  });

  console.log("statusing");
  if (!response.ok) {
    throw new Error(`Error fetching domain status: ${response.statusText}`);
  }

  return response.json();
}

async function processToolCalls(messages, tools, modeluse) {
  console.log(messages);
  const response = await ollama.chat({
    model: modeluse,
    messages,
    tools,
    stream: false,
  });
  console.log("GOT IT");

  if (
    response.message &&
    response.message.tool_calls &&
    response.message.tool_calls.length > 0
  ) {
    let toolCall = response.message.tool_calls[0];
    let toolName = toolCall.function.name;
    let args = toolCall.function.arguments;
    console.log("here");
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch (e) {
        console.error("Failed to parse tool arguments:", e, args);
        args = {};
      }
    }

    const toolMap = {
      searchDomains: async (args) => await searchDomains(args.query),
      getDomainStatus: async (args) => await getDomainStatus(args.domain),
    };

    if (toolMap[toolName]) {
      let toolResult = await toolMap[toolName](args);

      let newMessages = [
        ...messages,
        response.message,
        {
          role: "tool",
          tool_name: toolName,
          content: JSON.stringify(toolResult),
        },
      ];

      console.log(
        "LLM tool requested:",
        util.inspect(response.message, false, null, true)
      );
      console.log(
        "LLM tool called:",
        util.inspect(newMessages.slice(-1), false, null, true)
      );

      // recursively process until no more tools are called
      let nextResult = await processToolCalls(newMessages, tools);

      return {
        message: nextResult.message,
        toolCalls: [toolCall, ...nextResult.toolCalls],
        toolResults: [toolResult, ...nextResult.toolResults],
      };
    } else {
      console.log("Unknown tool called:", toolName);
    }
  }

  return {
    message: response.message,
    toolCalls: [],
    toolResults: [],
  };
}

app.post("/domains", async (req, res) => {
  try {
    const requestData = req.body;

    console.log("Reuest data:", requestData);

    const tools = [searchDomainToolSchema, getDomainStatusToolSchema];

    console.log("im here");
    const result = await processToolCalls(
      requestData.messages,
      tools,
      requestData.model
    );
    console.log("im here 2");

    res.json(result.message);
  } catch (error) {
    console.error("Error proxying to golem:", error);
    res.status(500).json({ error: "Failed to fetch from golem" });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
