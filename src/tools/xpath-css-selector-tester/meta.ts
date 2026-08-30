import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "xpath-css-selector-tester",
  name: "XPath and CSS Selector Tester",
  description:
    "Test XPath expressions and CSS selectors against pasted HTML and see every match with its path and text.",
  category: "Dev",
  keywords: [
    "xpath tester",
    "css selector tester",
    "test css selector online",
    "xpath evaluator",
    "html selector tester",
    "scraper selector test",
    "querySelectorAll tester",
    "xpath vs css selector",
  ],
  searchTerms: [
    "selector playground",
    "scrapy selector",
    "beautifulsoup select",
    "puppeteer selector",
    "playwright locator",
    "selenium xpath",
    "does this selector match",
    "find element by xpath",
    "html query",
    "dom query tester",
    "cheerio selector",
    "web scraping selector",
  ],
  icon: "ScanSearch",
  input: "text/html",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "css",
      options: [
        {
          value: "css",
          label: "CSS selector",
          synonyms: ["querySelectorAll", "css", "stylesheet selector", "jquery selector"],
        },
        {
          value: "xpath",
          label: "XPath",
          synonyms: ["xpath 1.0", "document.evaluate", "selenium", "lxml"],
        },
      ],
    },
    {
      kind: "text",
      id: "selector",
      label: "Selector",
      default: "",
      placeholder: "ul.menu > li.item",
    },
    {
      kind: "boolean",
      id: "showMarkup",
      label: "Show the markup of each match",
      default: false,
    },
    {
      kind: "number",
      id: "maxMatches",
      label: "Matches to list",
      default: 200,
      min: 1,
      max: 5000,
      step: 1,
    },
  ],
  examples: [
    {
      label: "Pick the done items out of a list",
      input:
        '<ul class="menu">\n  <li class="item">Buy milk</li>\n  <li class="item done">Ship it</li>\n  <li class="item">Write tests</li>\n</ul>',
      opts: { selector: "ul.menu > li.item.done", mode: "css", showMarkup: "true" },
    },
  ],
  copy: {
    what: "Runs a CSS selector or an XPath expression against HTML you paste in and lists every node it matched, with a path back to each one, its visible text, and optionally its markup. Both modes use the engines your browser already ships, querySelectorAll for CSS and document.evaluate for XPath, so a selector that works here works in your scraper, your test, or your console. It also breaks the selector down into plain English, one line per step, which is usually enough to spot the mistake without running anything.",
    how: "Pick CSS or XPath, type the selector, and paste the HTML underneath. Matches are highlighted in the markup and listed below with their path, so you can tell the second list item from the fifth. Turn on the markup option to see the full outerHTML of each hit. The mode, the selector, and the HTML all live in the URL fragment, so one link shares the whole test case with a colleague.",
    why: "Testing a selector usually means a browser console on a page you cannot easily reshape, or a scraping site that wants a signup before it will run a second query. This page takes any markup you paste, runs both selector languages side by side, and puts no counter on how many times you press it. Everything runs in this tab, so your files and inputs never leave your device.",
    faq: [
      {
        q: "Which XPath version does the browser support?",
        a: "XPath 1.0, which is what document.evaluate implements. Axes, predicates, and the common functions are all there: text(), last(), position(), contains(), starts-with(), normalize-space(), count(), and the name and local-name pair. XPath 2.0 and later additions such as matches(), ends-with(), and sequence types are not available in any browser, so an expression written for lxml or Saxon may need trimming.",
      },
      {
        q: "Should I use a CSS selector or XPath?",
        a: "CSS is shorter and faster for the common cases: tag, class, id, attribute, and the child and sibling combinators. XPath earns its keep when you need to walk upward to a parent or ancestor, select an attribute or a text node directly rather than the element holding it, or filter on the text a node contains. If a CSS selector can express it, prefer CSS, because every scraping library speaks it.",
      },
      {
        q: "Why does my selector match here but not on the live site?",
        a: "Three usual causes. The live page builds that part of the DOM with JavaScript, so the markup you copied from view source never contained it. The page is inside an iframe or a shadow root, which neither querySelectorAll nor XPath crosses. Or the class you keyed on is generated per build, so it changed since you copied the HTML. Pasting the markup from the browser's Elements panel rather than view source rules out the first one.",
      },
    ],
  },
};
