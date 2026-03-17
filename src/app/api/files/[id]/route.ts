import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const { id } = await params;
    const invoice = await prisma.invoice.findUnique({
      where: { id },
    });

    if (!invoice || invoice.userId !== session.user.id) {
      return new NextResponse("Not Found or Unauthorized", { status: 404 });
    }

    if (!existsSync(invoice.filePath)) {
      return new NextResponse("File not found on disk", { status: 404 });
    }

    const fileBuffer = await readFile(invoice.filePath);
    const ext = invoice.filePath.split('.').pop()?.toLowerCase();
    
    // Determine content type
    let contentType = "application/octet-stream";
    if (ext === "pdf") contentType = "application/pdf";
    else if (ext === "jpg" || ext === "jpeg") contentType = "image/jpeg";
    else if (ext === "png") contentType = "image/png";

    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${encodeURIComponent(invoice.originalName || "invoice")}"`,
      },
    });

  } catch (error: any) {
    console.error("Error serving file:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
