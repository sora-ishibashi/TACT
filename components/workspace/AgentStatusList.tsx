"use client";

type Props = {
  status?: Record<string, string>;
};

const agents = [
  {
    id: "planner",
    name: "Planner",
    icon: "🧠",
  },
  {
    id: "researcher",
    name: "Researcher",
    icon: "🔍",
  },
  {
    id: "designer",
    name: "Designer",
    icon: "🎨",
  },
  {
    id: "engineer",
    name: "Engineer",
    icon: "💻",
  },
  {
    id: "stakeholder",
    name: "Stakeholder",
    icon: "👥",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    icon: "✅",
  },
  {
    id: "writer",
    name: "Writer",
    icon: "✍️",
  },
];


function statusLabel(value: string) {

  switch(value) {

    case "running":
      return "実行中";

    case "completed":
      return "完了";

    case "failed":
      return "失敗";

    default:
      return "待機";

  }

}


function statusStyle(value: string) {

  switch(value) {

    case "running":
      return "text-blue-600 bg-blue-50";

    case "completed":
      return "text-green-600 bg-green-50";

    case "failed":
      return "text-red-600 bg-red-50";

    default:
      return "text-gray-500 bg-gray-50";

  }

}


export default function AgentStatusList({
  status = {},
}: Props) {

  return (

    <div className="space-y-2">

      {agents.map((agent) => {

        const current =
          status[agent.id] ?? "";

        return (

          <div
            key={agent.id}
            className="
              flex
              items-center
              justify-between
              rounded-lg
              border
              border-gray-100
              bg-white
              px-3
              py-2
            "
          >

            <div className="flex items-center gap-2">

              <span className="text-lg">
                {agent.icon}
              </span>

              <span className="text-sm font-medium text-gray-700">
                {agent.name}
              </span>

            </div>


            <span
              className={`
                rounded-full
                px-2
                py-1
                text-xs
                font-medium
                ${statusStyle(current)}
              `}
            >

              {statusLabel(current)}

            </span>


          </div>

        );

      })}

    </div>

  );

}