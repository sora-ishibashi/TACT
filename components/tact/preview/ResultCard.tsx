import Card from "../ui/Card";

export default function ResultCard({ result }: { result: { title: string; summary: string; items: string[] } }) {
  return (
    <Card>
      <p className="text-[13px] font-medium leading-[18px] text-[#112278]">結果</p>
      <h2 className="mt-2 text-[16px] font-medium leading-6 text-[#112278]">{result.title}</h2>
      <p className="mt-2 text-[13px] leading-[18px] text-[#626161]">{result.summary}</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] leading-[18px] text-[#112278]">{result.items.map((item) => <li key={item}>{item}</li>)}</ul>
    </Card>
  );
}
