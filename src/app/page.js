"use client";
import React, { useState } from "react";

const DomainGenerator = () => {
  const [keyWords, setKeyWords] = useState("");
  const [vibe, setVibe] = useState([]);
  const [tld, setTld] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);

  const generateCards = async () => {
    setLoading(true);
    setError(null);
    setItems([]);

    const content = `Help me with my business idea and domain names. Generate me some potential domain names based off these words ${keyWords}. I want the domain to be available with these tlds, ${tld} and this vibe ${vibe}`;

    const requestData = {
      messages: [
        {
          role: "system",
          content: `You are a business and domain name advisor. Respond ONLY in valid JSON. Provide domain name suggestions based on the user's business idea or keywords.Include a field "domain" with the suggested name, "tld" with a recommended TLD, and "reason" explaining why it's a good choice. If needed return whether or not the name is available.  Always return an array of suggestions.`,
        },
        { role: "user", content },
      ],
      model: "gpt-oss:120b",
      stream: false,
    };

    try {
      console.log(keyWords);
      const response = await fetch("http://localhost:4000/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestData),
      });
      if (!response.ok) throw new Error("Failed to generate");

      const data = await response.json();
      let parsed;
      console.log(parsed);
      try {
        parsed = JSON.parse(data.message.content);
        setItems(parsed);
      } catch (err) {
        throw new Error("Model did not return valid JSON");
      }
    } catch (err) {
      setError(err.message || "An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="bg-gray-900 min-h-screen flex flex-col md:flex-row gap-6 items-stretch p-6 text-gray-100">
      <div className="bg-gray-800 p-6 rounded-lg shadow-lg w-full md:w-96">
        <h2 className="text-2xl font-semibold text-center mb-6">
          Generate Domain Names
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300">
              Key Words
            </label>
            <input
              type="text"
              value={keyWords}
              onChange={(e) => setKeyWords(e.target.value)}
              className="mt-1 block w-full px-4 py-2 border border-gray-600 rounded-md bg-gray-700 text-gray-100 placeholder-gray-400"
              placeholder="e.g. adventure, fun, gear rental, roam"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Top Level Domain
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[".com", ".net", ".org", ".app", ".info", "Any"].map((type) => (
                <label
                  key={type}
                  className="flex items-center space-x-2 px-3 py-2 bg-gray-800 rounded-lg border border-gray-600 cursor-pointer hover:bg-gray-700 transition"
                >
                  <input
                    type="checkbox"
                    value={type}
                    checked={tld.includes(type)}
                    onChange={(e) => {
                      const value = e.target.value;
                      setTld((prev) =>
                        prev.includes(value)
                          ? prev.filter((v) => v !== value)
                          : [...prev, value]
                      );
                    }}
                    className="h-4 w-4 text-indigo-500 bg-gray-700 border-gray-600 rounded focus:ring-indigo-500"
                  />
                  <span className="text-gray-100">
                    {type.replace("-", " ")}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Vibe
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {["Fun", "Abstract", "Business", "Any"].map((type) => (
                <label
                  key={type}
                  className="flex items-center space-x-2 px-3 py-2 bg-gray-800 rounded-lg border border-gray-600 cursor-pointer hover:bg-gray-700 transition"
                >
                  <input
                    type="checkbox"
                    value={type}
                    checked={vibe.includes(type)}
                    onChange={(e) => {
                      const value = e.target.value;
                      setVibe((prev) =>
                        prev.includes(value)
                          ? prev.filter((v) => v !== value)
                          : [...prev, value]
                      );
                    }}
                    className="h-4 w-4 text-indigo-500 bg-gray-700 border-gray-600 rounded focus:ring-indigo-500"
                  />
                  <span className="text-gray-100">
                    {type.replace("-", " ")}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <button
            onClick={generateCards}
            disabled={loading}
            className="w-full py-2 px-4 mt-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition"
          >
            {loading ? "Generating..." : "Generate"}
          </button>

          {error && <div className="text-red-500 text-sm mt-2">{error}</div>}
        </div>
      </div>

      <div className="flex-1 bg-gray-800 p-6 rounded-lg shadow-lg overflow-auto">
        {items.length > 0 ? (
          <>
            <h3 className="font-semibold mb-4 text-xl border-b border-gray-700 pb-2">
              Generated:
            </h3>
          </>
        ) : (
          <p className="text-gray-400">
            Domains will appear here after generation.
          </p>
        )}
      </div>
    </div>
  );
};

export default DomainGenerator;
