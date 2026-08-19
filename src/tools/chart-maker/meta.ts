import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "chart-maker",
  icon: "ChartColumn",
  matrixSlug: "chart",
  name: "Chart Maker",
  description: "Paste CSV and get a clean SVG or PNG chart with no watermark and no sign up.",
  category: "Data",
  keywords: [
    "chart maker",
    "csv to chart",
    "make a bar chart online",
    "line chart generator",
    "svg chart generator",
    "free chart maker no watermark",
    "pie chart generator",
    "graph maker from data",
  ],
  searchTerms: [
    "graph maker",
    "plot csv",
    "data visualization",
    "excel chart alternative",
    "bar graph creator",
    "donut chart",
    "scatter plot maker",
    "stacked bar chart",
    "area chart",
    "tsv to graph",
    "chart png export",
  ],
  input: "text/csv",
  output: "image/svg+xml",
  options: [
    {
      kind: "select",
      id: "type",
      label: "Chart type",
      default: "bar",
      groups: [
        {
          label: "Bars",
          synonyms: ["column", "histogram", "bar graph"],
          options: [
            {
              value: "bar",
              label: "Bar",
              synonyms: ["column", "grouped bar", "vertical bar", "bar graph"],
            },
            {
              value: "stacked-bar",
              label: "Stacked bar",
              synonyms: ["stack", "stacked column", "composition"],
            },
            {
              value: "horizontal-bar",
              label: "Horizontal bar",
              synonyms: ["hbar", "row chart", "sideways bar", "ranking"],
            },
          ],
        },
        {
          label: "Lines and points",
          synonyms: ["trend", "time series", "xy"],
          options: [
            { value: "line", label: "Line", synonyms: ["trend", "time series", "curve"] },
            { value: "area", label: "Area", synonyms: ["filled line", "shaded", "volume"] },
            {
              value: "scatter",
              label: "Scatter",
              synonyms: ["xy plot", "dot plot", "correlation", "points"],
            },
          ],
        },
        {
          label: "Parts of a whole",
          synonyms: ["share", "percentage", "breakdown"],
          options: [
            { value: "pie", label: "Pie", synonyms: ["circle chart", "share", "percentage"] },
            { value: "donut", label: "Donut", synonyms: ["doughnut", "ring", "hole"] },
          ],
        },
      ],
    },
    { kind: "number", id: "width", label: "Width", default: 800, min: 320, max: 1600, step: 10 },
    { kind: "number", id: "height", label: "Height", default: 450, min: 200, max: 1000, step: 10 },
    { kind: "boolean", id: "legend", label: "Show legend", default: true },
    { kind: "boolean", id: "gridlines", label: "Show gridlines", default: true },
    { kind: "boolean", id: "valueLabels", label: "Label every value", default: false },
    {
      kind: "select",
      id: "palette",
      label: "Palette",
      default: "site",
      options: [
        {
          value: "site",
          label: "Site colors",
          synonyms: ["default", "brand", "categorical", "violet"],
        },
        { value: "mono", label: "Monochrome", synonyms: ["single color", "one hue", "mono"] },
        { value: "warm", label: "Warm", synonyms: ["red", "orange", "sunset"] },
        { value: "cool", label: "Cool", synonyms: ["blue", "teal", "green", "ocean"] },
      ],
    },
  ],
  http: { method: "POST", contentType: "image/svg+xml" },
  copy: {
    what: "Turns pasted CSV or TSV into a finished SVG chart: bar, stacked bar, horizontal bar, line, area, scatter, pie or donut. The first column becomes the labels, every column after it becomes a series, and the delimiter is detected for you, so comma, tab, semicolon and pipe files all work. Numbers written the way spreadsheets export them are understood, including 1,234, $99 and 45%, and blank cells stay as gaps instead of turning into zeros. The axis picks round tick values, the text adapts to light and dark, and nothing is stamped on the image.",
    how: 'Paste your data or drop a .csv file, then pick a chart type. Add a first line like "# Monthly revenue" to give the chart a title. Set the width and height, choose a palette, and toggle the legend, the gridlines or per value labels. Copy the SVG for a document or website, or export a PNG when you need a raster image.',
    why: "Most free chart sites either watermark the export, hold the download behind an account, or upload your spreadsheet to render it. This one renders in your browser, so your files and inputs never leave your device, and the SVG it hands back is plain markup you can edit by hand: no watermark, no branding, no row cap, no sign up.",
    faq: [
      {
        q: "What data formats can I paste?",
        a: "CSV, TSV and any single character delimited text: comma, tab, semicolon and pipe are all detected automatically. Put the labels in the first column and the numbers in the columns after it. A first row of text is treated as the header and names each series, and values like 1,234, $99, 45% and (250) for a negative are all read as numbers.",
      },
      {
        q: "Is there a watermark on the chart?",
        a: "No. The SVG contains only your chart: axes, marks, labels and an optional legend. There is no logo, no attribution text and no branding of any kind, and the background is transparent so the chart sits on whatever page or slide you paste it into.",
      },
      {
        q: "Is my data uploaded anywhere?",
        a: "No. Parsing and drawing both happen in the browser tab: your files and inputs never leave your device. There is also a curl endpoint for scripting, and using it does send the data you post to it, so keep to the page when the numbers are sensitive.",
      },
    ],
  },
};
