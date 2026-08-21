// 客户端共享视图类型：与服务器快照（src/web/snapshot.ts）中的 ObjectView 结构化对应

export interface ObjectView {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
