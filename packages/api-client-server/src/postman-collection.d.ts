declare module "postman-collection" {
  export class VariableScope {
    constructor(opts?: any);
    set(key: string, value: unknown): void;
    get(key: string): unknown;
    replaceIn(target: any): any;
    [key: string]: any;
  }
  export class Collection {
    constructor(json: any);
    [key: string]: any;
  }
  export class Item {
    constructor(json: any);
    [key: string]: any;
  }
  export class ItemGroup {
    constructor(json: any);
    [key: string]: any;
  }
}
