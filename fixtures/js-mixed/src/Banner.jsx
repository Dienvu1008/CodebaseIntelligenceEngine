import { VERSION } from './esm.mjs';

export default function Banner({ title }) {
  return (
    <header>
      {title} v{VERSION}
    </header>
  );
}
