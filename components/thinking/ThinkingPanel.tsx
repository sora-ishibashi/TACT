type Props = {
  agent?: string;
  message?: string;
};

export default function ThinkingPanel({
  agent,
  message,
}: Props) {
  if (!agent) return null;

  return (
    <div className="mx-8 mt-6 rounded-2xl border border-blue-100 bg-blue-50 p-5">

      <div className="flex items-center gap-3">

        <div className="h-3 w-3 animate-pulse rounded-full bg-blue-500" />

        <p className="font-semibold text-blue-700">
          {agent}
        </p>

      </div>

      <p className="mt-3 text-gray-700">
        {message}
      </p>

      <div className="mt-5 flex gap-1">

        <span className="h-2 w-2 animate-bounce rounded-full bg-blue-500" />

        <span
          className="h-2 w-2 animate-bounce rounded-full bg-blue-500"
          style={{
            animationDelay: "0.15s",
          }}
        />

        <span
          className="h-2 w-2 animate-bounce rounded-full bg-blue-500"
          style={{
            animationDelay: "0.3s",
          }}
        />

      </div>

    </div>
  );
}