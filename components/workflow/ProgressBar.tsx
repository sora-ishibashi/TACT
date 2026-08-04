type Props = {
  status?: Record<string, string>;
};

const ORDER = [
  "planner",
  "researcher",
  "designer",
  "engineer",
  "stakeholder",
  "reviewer",
  "writer",
];

export default function ProgressBar({
  status,
}: Props) {

  if (!status) return null;

  const activeSteps = ORDER.filter(
    (agent) => status[agent] !== undefined
  );

  const completed =
    activeSteps.filter(
      (agent) =>
        status[agent] === "completed"
    ).length;

  const percent =
    activeSteps.length === 0
      ? 0
      : Math.round(
          (completed /
            activeSteps.length) *
            100
        );

  return (

    <div className="rounded-2xl border border-gray-200 bg-white p-6">

      <div className="mb-4 flex items-center justify-between">

        <h3 className="font-semibold">
          Progress
        </h3>

        <span className="text-sm text-gray-500">
          {percent}%
        </span>

      </div>

      <div className="h-3 overflow-hidden rounded-full bg-gray-100">

        <div
          className="h-full rounded-full bg-black transition-all duration-500"
          style={{
            width: `${percent}%`,
          }}
        />

      </div>

    </div>

  );

}