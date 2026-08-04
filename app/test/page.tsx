"use client";

import { useState } from "react";

export default function TestPage() {

  const [input, setInput] =
    useState("");

  const [output, setOutput] =
    useState("");

  const [loading, setLoading] =
    useState(false);

  const runTACT = async () => {

    setLoading(true);

    try {

      const response = await fetch(
        "/api/tact",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            input,
          }),
        }
      );

      const result =
        await response.json();

      setOutput(
        JSON.stringify(
          result,
          null,
          2
        )
      );

    } catch (error) {

      setOutput(
        String(error)
      );

    } finally {

      setLoading(false);

    }

  };

  return (

    <main
      style={{
        padding: 40,
        maxWidth: 800,
        margin: "0 auto",
      }}
    >

      <h1>
        TACT Playground
      </h1>

      <textarea
        value={input}
        onChange={e =>
          setInput(e.target.value)
        }
        rows={8}
        style={{
          width: "100%",
          marginTop: 20,
        }}
      />

      <button
        onClick={runTACT}
        disabled={loading}
        style={{
          marginTop: 20,
        }}
      >
        {loading
          ? "Running..."
          : "Run TACT"}
      </button>

      <pre
        style={{
          marginTop: 30,
          whiteSpace: "pre-wrap",
        }}
      >
        {output}
      </pre>

    </main>
  );
}