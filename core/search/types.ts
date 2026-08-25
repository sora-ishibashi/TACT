export type SearchResult = {

  title: string;

  url: string;

  content: string;

  score: number;

  // Phase43: 情報源が公開した日時(取得できた場合のみ)。TACTが検索結果を
  // 取得した時刻(retrievedAt、Evidence側で別途付与)とは別の意味を持つ
  // (絶対条件Rule3)。Providerが日時を返さない場合はundefinedのままとし、
  // 他のフィールド(createdAt/updatedAt等)から代用・推測しない
  // (絶対条件Rule2/4/5)。
  publishedAt?: string;

};

export type SearchProvider = {

  search(
    query: string
  ): Promise<SearchResult[]>;

};