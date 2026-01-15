export type ExtractedPhoto = {
  s3Key: string;
  width: number;
  height: number;
  index: number;
  /** Source document description */
  sourceDocument?: string;
};

export type DocumentResult = {
  description: string;
  url: string;
  localUrl: string;
  type: "pdf" | "docx" | "unknown";
  markdown: string | null | undefined;
  /** Path to the document file in tmp folder (for OCR processing) */
  tmpFilePath?: string;
};
