import clsx, { type ClassValue } from "clsx";

/** Tiny classname helper re-export. Keeps imports one line. */
export const cn = (...inputs: ClassValue[]) => clsx(inputs);
