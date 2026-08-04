"use client";

type Props = {
  status?: Record<string, string>;
};

const agents = [
  { id: "planner", icon: "🧠", x: 50, y: 10 },
  { id: "researcher", icon: "🔍", x: 15, y: 35 },
  { id: "designer", icon: "🎨", x: 20, y: 75 },
  { id: "engineer", icon: "💻", x: 80, y: 75 },
  { id: "stakeholder", icon: "👥", x: 50, y: 92 },
  { id: "reviewer", icon: "✅", x: 85, y: 35 },
  { id: "writer", icon: "✍️", x: 50, y: 55 },
];


export default function TeamCanvas({
  status = {},
}: Props) {


  function ring(statusValue: string) {

    switch (statusValue) {

      case "completed":
        return "border-green-500";

      case "running":
        return "border-blue-500 animate-pulse";

      case "failed":
        return "border-red-500";

      default:
        return "border-gray-300";

    }

  }


  return (

    <div
      className="
        relative
        h-56
        w-full
        overflow-hidden
        rounded-xl
        border
        border-gray-200
        bg-white
      "
    >


      {/* 接続線 */}

      {agents.map((agent) => (

        <div
          key={agent.id}
          className="
            absolute
            left-1/2
            top-1/2
            h-px
            bg-gray-200
            origin-left
          "
          style={{
            width: "28%",
            transform:
              `
              rotate(
                ${
                  Math.atan2(
                    agent.y - 50,
                    agent.x - 50
                  ) * 180 / Math.PI
                }deg
              )
              `
          }}
        />

      ))}



      {/* 中央 TACT */}

      <div
        className="
          absolute
          left-1/2
          top-1/2
          z-10
          flex
          h-12
          w-12
          -translate-x-1/2
          -translate-y-1/2
          items-center
          justify-center
          rounded-full
          bg-gradient-to-br
          from-blue-600
          to-cyan-500
          text-sm
          font-bold
          text-white
          shadow-lg
        "
      >

        T

      </div>



      {/* Agents */}

      {agents.map((agent) => {


        const currentStatus =
          status[agent.id] ?? "";


        return (

          <div
            key={agent.id}
            className="
              absolute
              z-10
              flex
              flex-col
              items-center
            "
            style={{
              left: `${agent.x}%`,
              top: `${agent.y}%`,
              transform: "translate(-50%,-50%)"
            }}
          >


            <div
              className={`
                flex
                h-10
                w-10
                items-center
                justify-center
                rounded-full
                border-4
                bg-white
                text-lg
                shadow
                transition
                ${ring(currentStatus)}
              `}
            >

              {agent.icon}

            </div>


            <span
              className="
                mt-1
                text-[9px]
                text-gray-500
              "
            >

              {agent.id}

            </span>


          </div>

        );


      })}


    </div>

  );

}