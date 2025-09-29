const express = require("express");
const cors = require("cors");
const { ChatOllama } = require("@langchain/ollama");
const { HumanMessage, ToolMessage } = require("@langchain/core/messages");
const { StateGraph, START, END } = require("@langchain/langgraph");
const { StructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const API_KEY = process.env.API_KEY;
const BASE_URL = "https://domainr.p.rapidapi.com/v2";

const app = express();
const port = 4000;

app.use(express.json());
app.use(cors());

const llm = new ChatOllama({
  baseUrl: "http://100.64.0.1:11434",
  model: "gpt-oss:120b",
});

// ------------------- TOOLS -------------------

class SearchDomainsTool extends StructuredTool {
  name = "searchDomains";
  description =
    "Returns domain name suggestions and variations based on a given query.";

  schema = z.object({
    query: z
      .string()
      .describe(
        "The keyword or phrase to search domains for (e.g. 'acme cafe')."
      ),
  });

  async _call({ query }) {
    try {
      const url = `${BASE_URL}/search?query=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          "X-RapidAPI-Key": API_KEY,
          "X-RapidAPI-Host": "domainr.p.rapidapi.com",
        },
      });

      if (!response.ok) {
        throw new Error(`Domainr API search error: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (err) {
      console.error("Error in searchDomains:", err.message);
      return { error: err.message };
    }
  }
}

class GetDomainStatusTool extends StructuredTool {
  name = "getDomainStatus";
  description =
    "Checks availability of up to 5 domains. Status 'inactive' or 'undelegated' = available.";

  schema = z.object({
    domains: z
      .array(z.string())
      .max(5)
      .describe(
        "List of up to 5 fully qualified domain names (e.g. acme.com)."
      ),
  });

  async _call({ domains }) {
    const results = [];
    for (const domain of domains) {
      try {
        const url = `${BASE_URL}/status?domain=${encodeURIComponent(domain)}`;
        const response = await fetch(url, {
          headers: {
            "X-RapidAPI-Key": API_KEY,
            "X-RapidAPI-Host": "domainr.p.rapidapi.com",
          },
        });

        if (!response.ok) {
          results.push({ domain, status: "error" });
          continue;
        }
        const data = await response.json();
        results.push(...(data.status || [{ domain, status: "error" }]));
      } catch (err) {
        results.push({ domain, status: "error", error: err.message });
      }
    }
    return { status: results };
  }
}

const searchTool = new SearchDomainsTool();
const statusTool = new GetDomainStatusTool();

// ------------------- LANGGRAPH -------------------

const graphStateData = {
  query: "",
  result: "",
};

async function domainNode(state) {
  const message = new HumanMessage({
    content: `The user wants domain ideas for: ${state.query}. 
Use your tools to search and check availability.`,
  });

  const llmWithTools = llm.bind({ tools: [searchTool, statusTool] });
  const response = await llmWithTools.invoke([message]);

  console.log("RAW LLM RESPONSE:", response);

  // run all tool calls
  if (response.tool_calls?.length) {
    const toolResults = [];
    for (const call of response.tool_calls) {
      if (call.name === "searchDomains") {
        console.log("Search tool requested");
        const r = await searchTool.invoke(call.args);
        toolResults.push({ tool: "searchDomains", result: r });
      } else if (call.name === "getDomainStatus") {
        console.log("Get domain status tool requested");
        const r = await statusTool.invoke(call.args);
        toolResults.push({ tool: "getDomainStatus", result: r });
      }
    }

    const toolMessage = new HumanMessage({
      content: `Tool results: ${JSON.stringify(toolResults)}`,
    });
    const response2 = await llm.invoke([message, toolMessage]);

    return { result: response2.content, query: state.query };
  }

  return { result: response.content, query: state.query };
}

const workflow = new StateGraph({ channels: graphStateData });
workflow.addNode("domains", domainNode);
workflow.addEdge(START, "domains");
workflow.addEdge("domains", END);

const graph = workflow.compile();

app.post("/domains", async (req, res) => {
  try {
    let userMessage = "";

    if (Array.isArray(req.body.messages)) {
      userMessage =
        req.body.messages.find((m) => m.role === "user")?.content || "";
    } else if (req.body.query) {
      userMessage = req.body.query;
    }

    if (!userMessage) {
      return res.status(400).json({ error: "No user query provided" });
    }

    const result = await graph.invoke({ query: userMessage });

    console.log("GRAPH RESULT:", result);
    res.json(result);
  } catch (err) {
    console.error("Error in /domains:", err);
    res.status(500).json({ error: "Failed to process domains" });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
