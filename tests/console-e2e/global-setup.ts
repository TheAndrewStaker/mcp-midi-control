/** Renders the synthetic fixture page once before the suite runs. */
import { writeFixture } from './fixture.js';

export default function globalSetup(): void {
  const path = writeFixture();
  console.log(`console-e2e fixture: ${path}`);
}
