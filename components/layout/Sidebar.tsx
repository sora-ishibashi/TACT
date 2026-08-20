"use client";

type Props = {
  onToggleConversationList?: () => void;
};

export default function Sidebar({
  onToggleConversationList,
}: Props) {

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
          onClick={onToggleConversationList}
          title="Conversation一覧"
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


        {/*
          STEP24: 押しても何も起きないボタンはユーザーを迷わせるため、
          未実装であることが分かるようdisabled + 低opacity + title
          で明示する(機能自体は今回追加しない)。
        */}

        <button
          disabled
          title="準備中"
          className="
            flex
            h-10
            w-10
            cursor-not-allowed
            items-center
            justify-center
            rounded-lg
            text-xl
            opacity-30
          "
        >
          📁
        </button>


        <button
          disabled
          title="準備中"
          className="
            flex
            h-10
            w-10
            cursor-not-allowed
            items-center
            justify-center
            rounded-lg
            text-xl
            opacity-30
          "
        >
          ⚙️
        </button>

      </nav>


    </aside>

  );

}
