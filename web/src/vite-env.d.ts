/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIM_API_BASE_URL?: string;
  readonly VITE_COGNITO_AUTHORITY?: string;
  readonly VITE_COGNITO_DOMAIN?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.module.css" {
  const classes: Record<string, string> & { [key: string]: string };
  export default classes;
}

declare module "*.css";
