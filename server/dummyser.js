const express = require("express");
const util = require("util");

const { ChatOllama } = require("@langchain/ollama");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
const { StateGraph, START, END } = require("@langchain/langgraph");
const { StructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");

const app = express();
const port = 4000;

app.use(express.json());
app.use(express.static("public"));

const apiKey = "eaf2817ae93e8a5f39ed023f4c5915c8";

const model = "gpt-oss:20b";
//const model = 'llama4:scout';
const llm = new ChatOllama({
  baseUrl: "http://100.64.0.1:11434",
  model: model,
});

// LANGGRAPH CODE GOES HERE

class GetWeatherTool extends StructuredTool {
  name = "GetWeather";
  description = "Get weather information for a city";

  schema = z.object({
    city: z
      .string()
      .describe(
        "The city and country ONLY, e.g. 'New York, US'. Do not include the state or other descriptors."
      ),
  });

  async _call({ city }) {
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=imperial`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `Weather API error: ${response.status} ${response.statusText}`
        );
      }

      const weatherData = await response.json();

      return {
        city: weatherData.name,
        temperature: weatherData.main.temp,
        humidity: weatherData.main.humidity,
        conditions: weatherData.weather[0].description,
      };
    } catch (error) {
      console.error("Error fetching weather data:", error);

      return {
        city: city,
        temperature: null,
        humidity: null,
        conditions: "weather unknown",
      };
    }
  }
}

const weatherTool = new GetWeatherTool();

class CalculatorTool extends StructuredTool {
  name = "Calculator";
  description =
    "A simple calculator that can add two numbers. Be precise with input types.";

  schema = z.object({
    a: z
      .number()
      .describe("The first number to add. String values are not accepted."),
    b: z
      .number()
      .describe("The second number to add. String values are not accepted."),
  });

  async _call({ a, b }) {
    return a + b + 2;
  }
}

const graphStateData = {
  destination: "",
  result: "",
};

// NODE #1: hello
async function helloNode(state) {
  // say hello to the LLM

  const message = new HumanMessage({
    content: [
      {
        type: "text",
        text: `Find the weather for ${state.destination}`,
      },
    ],
  });

  //const calcTool = new CalculatorTool();
  const llmWithTool = llm.bind({ tools: [weatherTool] });
  const response = await llmWithTool.invoke([message]);

  console.log("RAW LLM RESPONSE:", response);

  const toolCall = response.tool_calls[0];
  // if the LLM requests a tool call
  if (toolCall && toolCall.name == "GetWeather") {
    console.log("TOOL REQUESTED BY LLM:", toolCall);

    // INVOKE THE TOOL!
    const toolResult = await weatherTool.invoke(toolCall.args);
    console.log("TOOL RESULT:", toolResult);

    const message2 = new HumanMessage({
      content: [
        {
          type: "text",
          text: `Tool result: ${JSON.stringify(toolResult)}`,
        },
      ],
    });

    console.log("SENDING TO LLM:", message2);
    console.log("SENDING TO LLM:", message);

    const response2 = await llm.invoke([message, message2]);
    return {
      result: response2.content,
    };
  } else {
    return {
      result: response.content,
    };
  }
}

// step 1: define a graph
const workflow = new StateGraph({ channels: graphStateData });

// step 2: define nodes
workflow.addNode("hello", helloNode);

// step 3: define edges
workflow.addEdge(START, "hello");
workflow.addEdge("hello", END);

// step 4: compile workflow/graph
const graph = workflow.compile();

// EXPRESS API CODE GOES HERE

app.post("/agenttest", async function (req, res) {
  const result = await graph.invoke({
    destination: req.body.destination,
  });

  console.log("GRAPH RESULT:", result);

  res.json(result);
});

app.listen(port, function () {
  console.log(`Server running on port ${port}`);
});
