"use client";
import React, { useState } from "react";

const FlashcardGenerator = () => {
  const [subject, setSubject] = useState("");
  const [level, setLevel] = useState("");
  const [examType, setExamType] = useState("flashcards");
  const [focusArea, setFocusArea] = useState("");
  const [numCards, setNumCards] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);

  const generateCards = async () => {
    setLoading(true);
    setError(null);
    setItems([]);

    const content = `Please make ${numCards} ${examType} questions for a ${subject} exam with a focus area of ${focusArea} with an academic level of ${level}.`;

    const requestData = {
      messages: [
        {
          role: "system",
          content: `You are a tutor. Respond ONLY in valid JSON.
If exam type = flashcards: return an array of {question, answer}.
If exam type = multiple-choice: return an array of {question, options:[], answer}.
If exam type = true-false: return an array of {question, options:[True,False], answer:True|False}.`,
        },
        { role: "user", content },
      ],
      model: "gpt-oss:120b",
      stream: false,
    };

    try {
      const response = await fetch("http://localhost:4000/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestData),
      });
      if (!response.ok) throw new Error("Failed to generate");

      const data = await response.json();
      console.log("raw response", data);

      let parsed;
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

  const [flipped, setFlipped] = useState({});

  const handleClick = (i) => {
    setFlipped((prev) => ({ ...prev, [i]: !prev[i] }));
  };

  const renderFlashcards = () => (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map((card, i) => {
        const text = flipped[i] ? card.answer : card.question;

        return (
          <div
            key={i}
            className="p-4 border rounded-lg shadow-sm bg-indigo-50 hover:shadow-md transition cursor-pointer"
            onClick={() => handleClick(i)}
          >
            <p className="font-bold text-indigo-800 mb-2">
              Q{i + 1}: {text}
            </p>
          </div>
        );
      })}
    </div>
  );

  const [selectedAnswers, setSelectedAnswers] = useState({});

  const renderMultipleChoice = () => (
    <div className="space-y-4">
      {items.map((q, i) => (
        <div
          key={i}
          className="p-4 border rounded-lg shadow bg-white hover:shadow-md transition"
        >
          <p className="font-bold text-indigo-800 mb-3">
            {i + 1}. {q.question}
          </p>

          {q.options && Array.isArray(q.options) ? (
            <ul className="space-y-2">
              {q.options.map((opt, j) => {
                const isSelected = selectedAnswers[i] === opt;
                const isCorrect = opt === q.answer;

                return (
                  <li
                    key={j}
                    onClick={() =>
                      setSelectedAnswers((prev) => ({ ...prev, [i]: opt }))
                    }
                    className={`px-3 py-2 rounded border cursor-pointer transition
                    ${
                      isSelected
                        ? "bg-indigo-100 border-indigo-500"
                        : "border-gray-300"
                    }
                    ${
                      isSelected && !isCorrect
                        ? "bg-red-100 border-red-500"
                        : ""
                    }
                  `}
                  >
                    {opt}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-gray-500">No options provided</p>
          )}
        </div>
      ))}
    </div>
  );

  const renderTrueFalse = () => (
    <div className="space-y-4">
      {items.map((q, i) => (
        <div
          key={i}
          className="p-4 border rounded-lg shadow bg-white hover:shadow-md transition"
        >
          <p className="font-bold text-indigo-800 mb-3">
            {i + 1}. {q.question}
          </p>

          {q.options && Array.isArray(q.options) ? (
            <ul className="space-y-2">
              {q.options.map((opt, j) => {
                const isSelected = selectedAnswers[i] === opt;
                const isCorrect =
                  String(opt).toLowerCase() === String(q.answer).toLowerCase();

                return (
                  <li
                    key={j}
                    onClick={() =>
                      setSelectedAnswers((prev) => ({ ...prev, [i]: opt }))
                    }
                    className={`px-3 py-2 rounded border cursor-pointer transition
                    ${
                      isSelected
                        ? "bg-indigo-100 border-indigo-500"
                        : "border-gray-300"
                    }
                    ${
                      isSelected && !isCorrect
                        ? "bg-red-100 border-red-500"
                        : ""
                    }
                  `}
                  >
                    {String(opt)}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-gray-500">No options provided</p>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="bg-gray-100 min-h-screen flex flex-col md:flex-row gap-6 items-stretch p-6">
      {/* Sidebar form */}
      <div className="bg-white p-6 rounded-lg shadow-lg w-full md:w-96">
        <h2 className="text-2xl font-semibold text-center mb-6">
          Generate Exam Questions
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Subject
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-md"
              placeholder="e.g. Human Anatomy"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Academic Level
            </label>
            <input
              type="text"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-md"
              placeholder="e.g. Collegiate"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Exam Type
            </label>
            <select
              value={examType}
              onChange={(e) => setExamType(e.target.value)}
              className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-md"
            >
              <option value="flashcards">Flashcards</option>
              <option value="multiple-choice">Multiple Choice</option>
              <option value="true-false">True/False</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Focus Area
            </label>
            <input
              type="text"
              value={focusArea}
              onChange={(e) => setFocusArea(e.target.value)}
              className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-md"
              placeholder="e.g. Muscular System"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Number of Questions
            </label>
            <input
              type="number"
              value={numCards}
              onChange={(e) => setNumCards(e.target.value)}
              className="mt-1 block w-full px-4 py-2 border border-gray-300 rounded-md"
              min="1"
            />
          </div>

          <button
            onClick={generateCards}
            disabled={loading}
            className="w-full py-2 px-4 mt-4 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
          >
            {loading ? "Generating..." : "Generate"}
          </button>

          {error && <div className="text-red-500 text-sm mt-2">{error}</div>}
        </div>
      </div>

      <div className="flex-1 bg-white p-6 rounded-lg shadow-lg overflow-auto">
        {items.length > 0 ? (
          <>
            <h3 className="font-semibold mb-4 text-xl border-b pb-2">
              Generated {examType}:
            </h3>
            {examType === "flashcards" && renderFlashcards()}
            {examType === "multiple-choice" && renderMultipleChoice()}
            {examType === "true-false" && renderTrueFalse()}
          </>
        ) : (
          <p className="text-gray-500">
            Questions will appear here after generation.
          </p>
        )}
      </div>
    </div>
  );
};

export default FlashcardGenerator;
