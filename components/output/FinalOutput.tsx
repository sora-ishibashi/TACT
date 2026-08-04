"use client";

type Props = {
  result: any;
};


function RenderValue({
  value,
}: {
  value: any;
}) {


  if (typeof value === "string") {

    return (

      <p
        className="
          whitespace-pre-wrap
          text-sm
          leading-6
          text-gray-700
        "
      >
        {value}
      </p>

    );

  }



  if (Array.isArray(value)) {

    return (

      <div className="space-y-3">

        {value.map(
          (
            item,
            index
          ) => (

            <div
              key={index}
              className="
                rounded-lg
                border
                border-gray-200
                bg-gray-50
                p-3
              "
            >

              {typeof item === "object" ? (

                Object.entries(item).map(
                  ([key, val]) => (

                    <div
                      key={key}
                      className="mb-2"
                    >

                      <h3
                        className="
                          text-xs
                          font-semibold
                          text-gray-900
                        "
                      >
                        {key}
                      </h3>


                      <RenderValue
                        value={val}
                      />


                    </div>

                  )
                )

              ) : (

                <p
                  className="
                    text-sm
                    leading-6
                    text-gray-700
                  "
                >
                  {item}
                </p>

              )}


            </div>

          )

        )}


      </div>

    );

  }




  if (
    typeof value === "object" &&
    value !== null
  ) {


    return (

      <div className="space-y-2">


        {Object.entries(value).map(
          ([key, val]) => (

            <div
              key={key}
            >

              <h3
                className="
                  text-xs
                  font-semibold
                  text-gray-900
                "
              >
                {key}
              </h3>


              <RenderValue
                value={val}
              />


            </div>

          )
        )}


      </div>

    );

  }



  return (

    <p
      className="
        text-sm
        text-gray-700
      "
    >
      {String(value)}
    </p>

  );

}





export default function FinalOutput({
  result,
}: Props) {


  if (!result) return null;



  return (

    <article
      className="
        mx-auto
        max-w-4xl
      "
    >



      <header
        className="
          mb-6
        "
      >


        <p
          className="
            text-[10px]
            font-semibold
            uppercase
            tracking-[0.2em]
            text-blue-600
          "
        >
          Final Output
        </p>



        <h1
          className="
            mt-2
            text-xl
            font-bold
            tracking-tight
            text-gray-900
          "
        >
          {result.title ?? "Untitled"}
        </h1>




        {result.summary && (

          <p
            className="
              mt-3
              text-sm
              leading-6
              text-gray-500
            "
          >
            {result.summary}
          </p>

        )}



      </header>





      <section
        className="
          space-y-5
        "
      >



        {typeof result.answer === "string" ? (


          <p
            className="
              whitespace-pre-wrap
              text-sm
              leading-6
              text-gray-800
            "
          >
            {result.answer}
          </p>


        ) : (



          Object.entries(
            result.answer ?? {}
          ).map(
            ([title, value]) => (


              <section
                key={title}
                className="
                  border-l-2
                  border-gray-200
                  pl-4
                "
              >


                <h2
                  className="
                    mb-3
                    text-sm
                    font-semibold
                    text-gray-900
                  "
                >
                  {title}
                </h2>



                <RenderValue
                  value={value}
                />


              </section>


            )

          )


        )}



      </section>







      {result.nextActions?.length > 0 && (


        <section
          className="
            mt-8
            border-t
            border-gray-200
            pt-5
          "
        >


          <h2
            className="
              mb-3
              text-sm
              font-semibold
              text-gray-900
            "
          >
            Next Actions
          </h2>



          <div
            className="
              space-y-2
            "
          >



            {result.nextActions.map(
              (
                action:string,
                index:number
              ) => (


                <div
                  key={index}
                  className="
                    flex
                    items-start
                    gap-2
                    rounded-lg
                    border
                    border-blue-100
                    bg-blue-50
                    px-3
                    py-3
                  "
                >


                  <span
                    className="
                      text-xs
                      font-semibold
                      text-blue-600
                    "
                  >
                    {index + 1}.
                  </span>



                  <span
                    className="
                      text-sm
                      leading-5
                      text-gray-800
                    "
                  >
                    {action}
                  </span>


                </div>


              )

            )}



          </div>


        </section>


      )}





    </article>

  );

}