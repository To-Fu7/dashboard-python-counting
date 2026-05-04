import { NextResponse } from 'next/server';
import { imageExists } from '@/lib/compose';

const IMAGE_NAME = 'python-counting-services-python-1:latest';

export async function GET() {
  const hasImage = await imageExists(IMAGE_NAME);
  return NextResponse.json({ imageReady: hasImage, imageName: IMAGE_NAME });
}
