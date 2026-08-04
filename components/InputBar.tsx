"use client";

import { useState } from "react";


type Props = {
  addMessage: (
    role: "user" | "tact",
    content: string
  ) => void;

  setWorkflow: (
    workflow: any
  ) => void;

  setResult: (
    result: any
  ) => void;

  setAgentOutputs: (
    outputs: any
  ) => void;

  setThinking: (
    thinking: any
  ) => void;
};


export default function InputBar({

  addMessage,

  setWorkflow,

  setResult,

  setAgentOutputs,

  setThinking,

}: Props) {


  const [input, setInput] =
    useState("");


  const [loading, setLoading] =
    useState(false);


  const [mode, setMode] =
    useState<
      "quick" | "think" | "deep"
    >("think");



  async function handleSubmit() {


    if (!input.trim()) return;


    const userMessage =
      input;


    addMessage(
      "user",
      userMessage
    );


    setInput("");


    setLoading(true);



    setWorkflow({

      status: {},

      logs: [],

      events: [],

    });



    try {


      const response =
        await fetch(
          `/api/tact/stream?input=${encodeURIComponent(
            userMessage
          )}&mode=${mode}`
        );



      if (!response.body) {

        throw new Error(
          "Stream not available"
        );

      }



      const reader =
        response.body.getReader();



      const decoder =
        new TextDecoder();



      let buffer = "";



      while (true) {


        const {
          done,
          value
        } =
          await reader.read();



        if (done) break;



        buffer +=
          decoder.decode(
            value,
            {
              stream:true
            }
          );



        const events =
          buffer.split(
            "\n\n"
          );



        buffer =
          events.pop() ?? "";



        for (
          const eventText
          of events
        ) {



          if (
            !eventText.startsWith(
              "data:"
            )
          ) continue;



          const json =
            eventText
              .replace(
                "data:",
                ""
              )
              .trim();



          if (!json) continue;



          const event =
            JSON.parse(
              json
            );



          console.log(
            "TACT EVENT",
            event
          );



          // 接続

          if(
            event.type === "connected"
          ){

            continue;

          }



          // Agent開始

          if(
            event.type === "start"
          ){


            setWorkflow(
              (prev:any)=>({

                ...prev,

                status:{

                  ...prev?.status,

                  [event.agent]:
                    "running"

                },


                events:[

                  ...(prev?.events ?? []),

                  event

                ]

              })
            );


          }



          // Agent完了

          if(
            event.type === "complete"
          ){


            setWorkflow(
              (prev:any)=>({

                ...prev,

                status:{

                  ...prev?.status,

                  [event.agent]:
                    "completed"

                },


                events:[

                  ...(prev?.events ?? []),

                  event

                ]

              })
            );


          }



          // Agent失敗

          if(
            event.type === "failed"
          ){


            setWorkflow(
              (prev:any)=>({

                ...prev,

                status:{

                  ...prev?.status,

                  [event.agent]:
                    "failed"

                },


                events:[

                  ...(prev?.events ?? []),

                  event

                ]

              })
            );


          }



          // 最終成果物

          if(
            event.type === "result"
          ){


            setResult(
              event.result
            );


          }



          // 完了

          if(
            event.type === "finished"
          ){


            setLoading(false);


          }



          // エラー

          if(
            event.type === "error"
          ){


            addMessage(

              "tact",

              `エラー: ${event.error}`

            );


          }


        }


      }



    } catch(error){


      console.error(
        error
      );


      addMessage(

        "tact",

        "TACTとの通信に失敗しました"

      );


    } finally {


      setLoading(false);


    }


  }



  return (

<div className="border-t border-gray-200 bg-white px-4 py-2">


      <div className="mx-auto max-w-4xl">



        {/* Mode Selector */}


<div className="mb-2 flex gap-2">

          {[
            "quick",
            "think",
            "deep",
          ].map((m)=>(


            <button

              key={m}

              onClick={()=>setMode(
                m as
                | "quick"
                | "think"
                | "deep"
              )}

              className={`
rounded-full px-3 py-1.5 text-xs
                ${
                  mode === m
                    ? "bg-black text-white"
                    : "bg-gray-100 hover:bg-gray-200"
                }
              `}

            >

              {m.toUpperCase()}


            </button>


          ))}


        </div>




        {/* Input */}


        <div className="flex items-center gap-4 rounded-xl border border-gray-300 bg-white px-4 py-2 shadow-sm">



          <button

            className="text-2xl text-gray-500 transition hover:text-gray-700"

          >

            +

          </button>




          <input


            value={input}


            onChange={(e)=>
              setInput(
                e.target.value
              )
            }


            onKeyDown={(e)=>{

              if(
                e.key === "Enter"
              ){

                handleSubmit();

              }

            }}


            type="text"


            placeholder="やりたいことを入力してください..."


            className="flex-1 bg-transparent text-gray-900 outline-none placeholder:text-gray-400"


          />




          <button


            onClick={
              handleSubmit
            }


            disabled={
              loading
            }


            className="rounded-lg bg-black px-4 py-2 text-white transition hover:bg-gray-800 disabled:opacity-50"


          >


            {loading

              ? "実行中..."

              : "送信"

            }


          </button>



        </div>


      </div>


    </div>

  );

}