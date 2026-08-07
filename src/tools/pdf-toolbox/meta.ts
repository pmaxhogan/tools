import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'pdf-toolbox',
  icon: 'FileText',
  matrixSlug: 'pdf',
  name: 'PDF Toolbox',
  description: 'Merge, split, rotate, reorder, watermark and fill PDFs in your browser.',
  category: 'Docs',
  keywords: [
    'merge pdf online free',
    'split pdf',
    'rotate pdf',
    'watermark pdf',
    'fill pdf form online',
    'pdf editor no upload',
    'delete pages from pdf',
    'reorder pdf pages',
  ],
  searchTerms: [
    'combine pdf files',
    'pdf merger',
    'extract pages from pdf',
    'pdf page rotator',
    'stamp watermark pdf',
    'fill out pdf form',
    'pdf form filler',
    'rearrange pdf pages',
    'remove pdf pages',
    'pdf splitter',
    'edit pdf online free',
    'ilovepdf alternative',
    'smallpdf alternative',
  ],
  input: 'File',
  output: 'text/plain',
  copy: {
    what: 'Six PDF jobs in one panel: merge several files into one, split or extract page ranges like 1-3,7,9-end, rotate pages a quarter turn at a time, reorder or delete pages, stamp a text watermark across every page, and fill in interactive form fields. Every file you load gets a first page thumbnail and a page strip so you can see what you are working on before you commit to it. The results come back as ordinary PDF downloads, named for what they contain. It does not compress PDFs and it does not add digital signatures, because doing either one properly needs more than a browser can honestly promise.',
    how: 'Drop one or more PDF files onto the panel, or pick them. Choose an operation from the tabs: merge uses the file list order, so use the arrows to arrange it first. Split and rotate take a page range in the same 1-3,7,9-end shape, checked live against the real page count. Watermark gives you text, size, opacity, angle, color and placement controls. Fill form reads the fields out of the document and renders one input per field, with an option to flatten the values in so they cannot be edited back out.',
    why: 'The big PDF sites upload your document to their servers to do work a browser can already do. That is a strange trade for the files people actually run through them: contracts, bank statements, tax forms, medical paperwork. Then they meter it, two files an hour unless you subscribe, and stamp their own watermark on the way out. This one does the whole job in the tab: your files and inputs never leave your device. No account, no queue, no daily limit, and no watermark you did not ask for.',
    faq: [
      {
        q: 'Is there a file size limit?',
        a: 'There is no limit imposed by the tool, but there is a real one imposed by memory. The whole file is held in your tab while it is edited, and a browser tab typically has a couple of gigabytes to work with, so a PDF in the low hundreds of megabytes is comfortable and a very large scanned book may not be. If a file is too big the tab slows down or the operation fails rather than silently truncating anything. Splitting a huge file into ranges first is usually the way through.',
      },
      {
        q: 'Can it remove a password from a protected PDF?',
        a: 'No, and it tells you so instead of pretending. If a PDF is encrypted, the page content is genuinely scrambled and cannot be read without the password, so the tool reports that the file is protected and stops. If you know the password, open the file in a viewer, save an unprotected copy, then load that copy here. A tool that offers to strip passwords from files you cannot open is either uploading them somewhere or guessing.',
      },
      {
        q: 'Are my documents uploaded anywhere?',
        a: 'No. Reading, merging, splitting, rotating, watermarking and form filling all run in your browser, so your files and inputs never leave your device. The page also keeps working offline after the first load, which is the easiest way to check the claim: turn off your network and the toolbox still works.',
      },
    ],
  },
};
