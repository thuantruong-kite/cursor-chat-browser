import { NextResponse } from "next/server";
import { execSync } from "child_process";

export async function GET() {
  try {
    let isWSL = false;

    // Check if running in WSL
    try {
      const release = execSync("uname -r", { encoding: "utf8" }).toLowerCase();
      isWSL = release.includes("microsoft") || release.includes("wsl");
    } catch {
      // Not in WSL
    }

    return NextResponse.json({
      os: process.platform,
      isWSL,
    });
  } catch (error) {
    console.error("Failed to detect environment:", error);
    return NextResponse.json({
      os: "unknown",
      isWSL: false,
    });
  }
}
