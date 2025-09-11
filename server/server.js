const express = require("express");
const cors = require("cors");
const { Ollama } = require("ollama");
const util = require("util");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

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
  try {
    console.log("AQUI1");
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

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error in searchDomains:", error.message);
    throw error; // re-throw so calling function can handle it
  }
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

async function processToolCalls(messages, tools, model) {
  console.log("hellp");
  console.log(messages);
  console.log(tools);
  const response = await ollama.chat({
    model: model,
    messages: messages,
    tools: tools,
    stream: false,
  });
  console.log("LLM response:", util.inspect(response, false, null, true));

  if (
    response.message &&
    response.message.tool_calls &&
    response.message.tool_calls.length > 0
  ) {
    // the LLM decided to respond with a tool call request

    let toolCall = response.message.tool_calls[0];
    console.log(tool_call);
    if (toolCall.function.name == "searchDomains") {
      // call the tool!
      let weatherData = await searchDomains(toolCall.function.arguments.query);

      let newMessages = [
        // previous messages:
        ...messages,

        // the tool call message:
        response.message,

        // the tool result message:
        {
          role: "tool",
          tool_name: toolCall.function.name,
          content: JSON.stringify(weatherData),
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

      let nextResult = await processToolCalls(newMessages, tools);

      return {
        message: nextResult.message,

        // for debugging:
        toolCalls: [toolCall, ...nextResult.toolCalls],
        toolResults: [weatherData, ...nextResult.toolResults],
      };
    } else {
      console.log("Unknown tool called:", toolCall.function.name);
    }
  }

  // the LLM either didn't request a tool call or called an unrecognized tool
  return {
    message: response.message,
    toolCalls: [],
    toolResults: [],
  };
}

app.post("/domains", async (req, res) => {
  try {
    const requestData = req.body;

    console.log("Reuest data:", requestData.messages);

    console.log("KEY", API_KEY);

    let resp = await searchDomains("acme");
    console.log(resp);

    const tools = [searchDomainToolSchema, getDomainStatusToolSchema];

    console.log("im here");
    const result = await processToolCalls(
      requestData.messages,
      [searchDomainToolSchema],
      requestData.model
    );
    console.log("im here 2");
    console.log(result.message);

    res.json({ message: { content: result.message.content } });
  } catch (error) {
    console.error("Error proxying to golem:", error);
    res.status(500).json({ error: "Failed to fetch from golem" });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
