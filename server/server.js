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

app.options("*", cors(corsOptions));

//const ollama = new Ollama({ host: "http://100.64.0.1:11434" });
const ollama = new Ollama({ host: "http://localhost:11434" });

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
  console.log("HELLO");
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
  console.log("I AM HERE");
  console.log("Calling Ollama...");
  const response = await ollama.chat({
    model,
    messages,
    tools,
    stream: false,
  });
  console.log("Ollama finished");

  console.log("LLM response:", util.inspect(response, false, null, true));

  if (response.message?.tool_calls?.length > 0) {
    const toolCall = response.message.tool_calls[0];

    if (toolCall.function.name === "searchDomains") {
      const data = await searchDomains(toolCall.function.arguments.query);

      const suggestions = (data.results || []).map((r) => {
        const domain = r.domain || "";
        const tld = domain.includes(".") ? "." + domain.split(".").pop() : "";
        return {
          domain: domain.replace(tld, ""),
          tld: tld || ".com",
          reason: "Suggested by Domainr API",
          available: !(r.subdomain || r.host),
        };
      });

      return {
        message: {
          role: "assistant",
          content: JSON.stringify({ suggestions }, null, 2),
        },
        toolCalls: [toolCall],
        toolResults: [data],
      };
    }

    if (toolCall.function.name === "getDomainStatus") {
      const data = await getDomainStatus(toolCall.function.arguments.domain);

      const suggestions = (data.status || []).map((s) => {
        return {
          domain: s.domain || toolCall.function.arguments.domain,
          tld: s.domain?.includes(".") ? "." + s.domain.split(".").pop() : "",
          reason: `Status check for ${s.domain}`,
          available:
            s.status?.includes("inactive") || s.status?.includes("undelegated"),
        };
      });

      return {
        message: {
          role: "assistant",
          content: JSON.stringify({ suggestions }, null, 2),
        },
        toolCalls: [toolCall],
        toolResults: [data],
      };
    }
  }

  return {
    message: {
      role: "assistant",
      content: JSON.stringify({ suggestions: [] }, null, 2),
    },
    toolCalls: [],
    toolResults: [],
  };
}

app.post("/domains", async (req, res) => {
  try {
    const requestData = req.body;

    console.log("Reuest data:", requestData.messages);

    console.log("KEY", API_KEY);

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

// app.post("/domains", (req, res) => {
//   res.json({
//     message: {
//       content:
//         '{"suggestions":[{"domain":"test","tld":".com","reason":"demo","available":true}]}',
//     },
//   });
// });

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
