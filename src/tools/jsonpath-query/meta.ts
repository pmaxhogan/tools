import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "jsonpath-query",
  name: "JSONPath Query",
  description: "Run a JSONPath expression against pasted JSON and see every match and its path.",
  category: "Dev",
  keywords: [
    "jsonpath query",
    "jsonpath tester",
    "jsonpath evaluator online",
    "query json with jsonpath",
    "jsonpath filter expression",
    "json path finder",
    "extract values from json",
  ],
  searchTerms: [
    "json path",
    "jsonpath online",
    "jq alternative",
    "json selector",
    "json xpath",
    "recursive descent json",
    "json filter query",
    "find value in json",
    "json array slice",
    "goessner jsonpath",
    "rfc 9535",
    "json query language",
  ],
  icon: "Braces",
  input: "application/json",
  output: "application/json",
  options: [
    {
      kind: "text",
      id: "path",
      label: "JSONPath",
      default: "$..*",
      placeholder: "$.store.book[*].author",
    },
    { kind: "boolean", id: "unwrap", label: "Unwrap a single match", default: true },
    { kind: "number", id: "indent", label: "Result indent (spaces)", default: 2, min: 0, max: 8 },
  ],
  examples: [
    {
      label: "Cheap books from the store",
      input:
        '{"store":{"book":[{"category":"reference","author":"Nigel Rees","title":"Sayings of the Century","price":8.95},{"category":"fiction","author":"Evelyn Waugh","title":"Sword of Honor","price":12.99},{"category":"fiction","author":"Herman Melville","title":"Moby Dick","isbn":"0-553-21311-3","price":8.99}],"bicycle":{"color":"red","price":19.95}}}',
      opts: { path: "$.store.book[?(@.price < 10)].title", unwrap: "true", indent: "2" },
    },
  ],
  copy: {
    what: "Runs a JSONPath expression over a JSON document you paste and shows every value it selects, together with the normalized bracket path each one came from. It covers the selectors people actually write: dot and bracket children, wildcards, recursive descent with two dots, array indexes including negative ones, slices with an optional step, comma unions, and filter expressions such as [?(@.price < 10 && @.category == 'fiction')]. Filters support the six comparison operators, a regular expression match with =~, existence tests, and the logical operators &&, || and ! with parentheses. The evaluator is hand written with a tokenizer and a recursive descent parser, so no part of your expression is ever passed to eval.",
    how: "Paste or drop the JSON into the input box, then type the expression into the JSONPath field, for example $.store.book[*].author. The Matches row tells you how many values were selected, Paths lists where each one lives as $['store']['book'][0]['author'], and Result holds the selected values as JSON you can copy straight into code or a test fixture. Turn off \"Unwrap a single match\" if you always want an array back, and set the indent to 0 when you want the result on one compact line. The expression and the options travel in the URL, so a link reproduces the exact query.",
    why: "Most JSONPath playgrounds run your filter through the browser's eval, wrap the page in ads, and upload the document to a server before they will evaluate anything. This one parses the filter grammar itself, has no ads and no sign in, and evaluates everything in this tab, so your files and inputs never leave your device. You also get the normalized path for every match, which is the part you need when you are writing an assertion or a config selector rather than just eyeballing a value.",
    faq: [
      {
        q: "Exactly which JSONPath syntax is supported?",
        a: "Supported: the root $, dot children ($.store.book), bracket children in single or double quotes, wildcards (.* and [*]), recursive descent (..), array indexes including negative ones, slices in [start:end:step] form with negative bounds, comma unions such as [0,2] and ['a','b'], and filters [?(...)] built from a relative path on the left (@, @.price, @['price'], @..price) compared against a number, a quoted string, true, false, or null with ==, !=, <, <=, >, >=, or matched against a /pattern/flags regular expression with =~, plus existence tests, !, &&, || and parentheses. Not supported: script expressions of any other kind, arithmetic inside a filter, function extensions such as length() or count(), the $.length pseudo property, comparing one path against another path, and parent or sibling axes. Anything outside that list is reported as a syntax error rather than silently ignored.",
      },
      {
        q: "What happens when a filter looks at a key that is missing?",
        a: "An existence test like [?(@.isbn)] is true whenever the path selects something, so it matches an item whose isbn is 0, an empty string, or false, and it is false only when the key is absent. For comparisons, a path that selects nothing makes every operator false except !=, which is true, so [?(@.price != 10)] also keeps an item that has no price at all. That is the rule RFC 9535 settled on, and it is why an existence test is the right way to say the key has to be there. A relative path that selects more than one value, such as @..price on a nested item, is not a single comparable value, so a comparison on it is false while an existence test on it is still true.",
      },
      {
        q: "How is this different from jq?",
        a: "jq is a full transformation language with pipes, functions, and its own output formatting; JSONPath is only a selector, so it answers where is this value rather than reshape this document. That makes JSONPath the right fit when the expression has to be stored somewhere else, in a Kubernetes -o jsonpath flag, a Postman or Karate assertion, a Spring or Jayway integration, or an API gateway mapping. This page shows both halves of that answer, the values and the normalized paths, and caps the report at 5000 matches so a broad query like $..* stays readable.",
      },
    ],
  },
};
