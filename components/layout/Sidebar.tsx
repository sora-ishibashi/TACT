"use client";

export default function Sidebar() {

  return (

    <aside
      className="
        flex
        h-full
        w-16
        shrink-0
        flex-col
        items-center
        border-r
        border-gray-200
        bg-white
        py-4
      "
    >

      {/* Logo */}

      <div
        className="
          mb-6
          flex
          h-10
          w-10
          items-center
          justify-center
          rounded-xl
          bg-gradient-to-br
          from-blue-600
          to-cyan-500
          text-sm
          font-bold
          text-white
          shadow
        "
      >
        T
      </div>



      {/* Navigation */}

      <nav
        className="
          flex
          flex-col
          gap-3
        "
      >

        <button
          className="
            flex
            h-10
            w-10
            items-center
            justify-center
            rounded-lg
            text-xl
            transition
            hover:bg-gray-100
          "
        >
          💬
        </button>


        <button
          className="
            flex
            h-10
            w-10
            items-center
            justify-center
            rounded-lg
            text-xl
            transition
            hover:bg-gray-100
          "
        >
          📁
        </button>


        <button
          className="
            flex
            h-10
            w-10
            items-center
            justify-center
            rounded-lg
            text-xl
            transition
            hover:bg-gray-100
          "
        >
          ⚙️
        </button>

      </nav>


    </aside>

  );

}