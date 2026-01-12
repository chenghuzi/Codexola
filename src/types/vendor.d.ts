declare module "react-file-icon";

declare module "prismjs" {
  namespace Prism {
    type Grammar = unknown;
  }

  const Prism: {
    languages: Record<string, unknown>;
    highlight: (text: string, grammar: Prism.Grammar, language: string) => string;
  };

  export default Prism;
}

declare module "prismjs/components/*";
