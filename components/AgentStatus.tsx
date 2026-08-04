type Props = {
  status?: Record<string, string>;
};

const agents = [
  { id: "planner", name: "Planner", icon: "🧠" },
  { id: "researcher", name: "Researcher", icon: "🔍" },
  { id: "designer", name: "Designer", icon: "🎨" },
  { id: "engineer", name: "Engineer", icon: "💻" },
  { id: "stakeholder", name: "Stakeholder", icon: "👥" },
  { id: "reviewer", name: "Reviewer", icon: "✅" },
  { id: "writer", name: "Writer", icon: "✍️" },
];

export default function AgentStatus({
  status = {},
}: Props) {

  function color(state: string) {

    switch (state) {

      case "completed":
        return "bg-green-500";

      case "running":
        return "bg-blue-500 animate-pulse";

      case "failed":
        return "bg-red-500";

      default:
        return "bg-gray-300";

    }

  }

  return (

    <div className="grid grid-cols-2 gap-3">

      {agents.map((agent) => {

        const current =
          status[agent.id] ?? "waiting";

        return (

          <div
            key={agent.id}
            className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3"
          >

            <div className="flex items-center gap-3">

              <span className="text-xl">
                {agent.icon}
              </span>

              <span className="text-sm font-medium">
                {agent.name}
              </span>

            </div>

            <div
              className={`h-3 w-3 rounded-full ${color(current)}`}
            />

          </div>

        );

      })}

    </div>

  );

}