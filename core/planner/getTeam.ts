export function getTeam(category: string) {

  switch (category) {

    case "coding":
      return [
        "queryBuilder",
        "researcher",
        "engineer",
        "reviewer",
        "writer",
      ];


    case "planning":
      return [
        "queryBuilder",
        "researcher",
        "designer",
        "stakeholder",
        "reviewer",
        "writer",
      ];


    case "design":
      return [
        "queryBuilder",
        "researcher",
        "designer",
        "reviewer",
        "writer",
      ];


    case "business":
      return [
        "queryBuilder",
        "researcher",
        "analyst",
        "stakeholder",
        "reviewer",
        "writer",
      ];


    case "writing":
      return [
        "queryBuilder",
        "researcher",
        "reviewer",
        "writer",
      ];


    case "research":
      return [
        "queryBuilder",
        "researcher",
        "analyst",
        "reviewer",
        "writer",
      ];


    default:
      return [
        "queryBuilder",
        "researcher",
        "reviewer",
        "writer",
      ];

  }

}