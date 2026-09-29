import { downloadFile } from "../telegram/api.js";

export interface DownloadedFile {
  data: Buffer;
  mimeType: string;
}

function mimeFromPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "oga":
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "mp4":
      return "video/mp4";
    default:
      return "audio/ogg";
  }
}

export type FileDownloader = (fileId: string) => Promise<DownloadedFile>;

let downloader: FileDownloader = async (fileId) => {
  const f = await downloadFile(fileId);
  return { data: f.data, mimeType: mimeFromPath(f.path) };
};

/** Test hook. */
export function setFileDownloader(d: FileDownloader) {
  downloader = d;
}

export function downloadFileForAnalysis(fileId: string): Promise<DownloadedFile> {
  return downloader(fileId);
}
