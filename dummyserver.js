const express = require("express");
const { Ollama } = require("ollama");
const util = require("util");
const cors = require("cors");
const app = express();
const port = 4000;
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
app.use(express.json());
app.use(express.static("public"));

const apiKey = "eaf2817ae93e8a5f39ed023f4c5915c8";
const model = "gpt-oss:20b";
const ollama = new Ollama({ host: "http://100.64.0.1:11434" });

const weatherToolSchema = {
  type: "function",
  function: {
    name: "getWeather",
    description: "Get weather information for a city",
    parameters: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description:
            "The city and country ONLY, e.g. 'New York, US'. Do not include the state or other descriptors.",
        },
      },
      required: ["city"],
    },
  },
};

async function getWeather(city) {
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

async function processToolCalls(messages, tools) {
  const response = await ollama.chat({
    model: model,
    messages: messages,
    tools: tools,
    stream: false,
  });
  //console.log("LLM response:", util.inspect(response, false, null, true));

  if (
    response.message &&
    response.message.tool_calls &&
    response.message.tool_calls.length > 0
  ) {
    // the LLM decided to respond with a tool call request

    let toolCall = response.message.tool_calls[0];
    if (toolCall.function.name == "getWeather") {
      // call the tool!
      let weatherData = await getWeather(toolCall.function.arguments.city);

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

app.post("/chat", async (req, res) => {
  try {
    const messages = req.body.messages;
    console.log(
      "Incoming messages:",
      util.inspect(messages, false, null, true)
    );

    const result = await processToolCalls(messages, [weatherToolSchema]);
    console.log("Final message:", util.inspect(result, false, null, true));

    res.json({
      response: result.message.content,
      tool_calls: result.toolCalls,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "LLM conversation failure" });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
