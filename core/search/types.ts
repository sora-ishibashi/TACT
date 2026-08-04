export type SearchResult = {

  title: string;

  url: string;

  content: string;

  score: number;

};

export type SearchProvider = {

  search(
    query: string
  ): Promise<SearchResult[]>;

};