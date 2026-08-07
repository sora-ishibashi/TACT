"use client";

type Props = {
  result: any;
};

export default function FinalOutput({
  result,
}: Props) {

  if (!result) return null;

  return (

    <article className="mx-auto max-w-4xl space-y-8">

      <header>

        <h1 className="text-3xl font-bold">
          {result.title}
        </h1>

        {result.executiveSummary && (

          <p className="mt-4 leading-7 text-gray-700">
            {result.executiveSummary}
          </p>

        )}

      </header>

      {result.keyFindings?.length > 0 && (

        <section>

          <h2 className="mb-3 text-xl font-semibold">
            Key Findings
          </h2>

          <ul className="list-disc space-y-2 pl-6">

            {result.keyFindings.map(
              (item:any,index:number)=>(

                <li key={index}>
                  <strong>{item.title}</strong>

                  <p>{item.description}</p>
                </li>

              )
            )}

          </ul>

        </section>

      )}

      {result.sections?.map(
        (section:any,index:number)=>(

          <section
            key={index}
            className="space-y-3"
          >

            <h2 className="text-2xl font-bold">
              {section.title}
            </h2>

            {section.content && (

              <p className="leading-7">
                {section.content}
              </p>

            )}

            {section.points?.length > 0 && (

              <ul className="list-disc pl-6 space-y-2">

                {section.points.map(
                  (
                    point:string,
                    i:number
                  )=>(

                    <li key={i}>
                      {point}
                    </li>

                  )
                )}

              </ul>

            )}

          </section>

        )
      )}

      {result.recommendations?.length > 0 && (

        <section>

          <h2 className="text-xl font-semibold mb-3">
            Recommendations
          </h2>

          <ul className="list-disc pl-6 space-y-2">

            {result.recommendations.map(
              (
                item:string,
                index:number
              )=>(

                <li key={index}>
                  {item}
                </li>

              )
            )}

          </ul>

        </section>

      )}

      {result.nextActions?.length > 0 && (

        <section>

          <h2 className="text-xl font-semibold mb-3">
            Next Actions
          </h2>

          <ol className="list-decimal pl-6 space-y-2">

            {result.nextActions.map(
              (
                item:string,
                index:number
              )=>(

                <li key={index}>
                  {item}
                </li>

              )
            )}

          </ol>

        </section>

      )}

    </article>

  );

}