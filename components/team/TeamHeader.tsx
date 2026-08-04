type Props = {
  planner: any;
  mode?: "quick" | "think" | "deep";
};

export default function TeamHeader({
  planner,
  mode = "think",
}: Props) {
  if (!planner) return null;

  const agents =
    planner.plan?.map(
      (step: any) => step.agent
    ) ?? [];

  return (
    <div className="rounded-2xl border border-blue-100 bg-blue-50 p-6">

      <div className="text-sm font-semibold text-blue-600">
        AI TEAM
      </div>

      <h2 className="mt-2 text-2xl font-bold">
        {planner.goal}
      </h2>

      <div className="mt-6 grid grid-cols-2 gap-6">

        <div>
          <p className="text-xs text-gray-500">
            Category
          </p>

          <p className="font-medium">
            {planner.category}
          </p>
        </div>

        <div>
          <p className="text-xs text-gray-500">
            Difficulty
          </p>

          <p className="font-medium">
            {planner.difficulty}
          </p>
        </div>

        <div>
          <p className="text-xs text-gray-500">
            Estimated
          </p>

          <p className="font-medium">
            {planner.estimatedTime}
          </p>
        </div>

        <div>
          <p className="text-xs text-gray-500">
            Mode
          </p>

          <p className="font-medium uppercase">
            {mode}
          </p>
        </div>

      </div>

      <div className="mt-6">

        <p className="text-xs text-gray-500">
          Agents
        </p>

        <div className="mt-2 flex flex-wrap gap-2">

          {agents.map((agent: string) => (

            <span
              key={agent}
              className="rounded-full bg-white px-3 py-1 text-sm"
            >
              {agent}
            </span>

          ))}

        </div>

      </div>

      <div className="mt-8">

        <p className="text-xs font-semibold text-gray-500">
          Planner Thinking
        </p>

        <div className="mt-2 rounded-xl bg-white p-4">
          {planner.thinking}
        </div>

      </div>

      <div className="mt-6">

        <p className="text-xs font-semibold text-gray-500">
          Why this team?
        </p>

        <div className="mt-2 rounded-xl bg-white p-4">
          {planner.reason}
        </div>

      </div>

    </div>
  );
}