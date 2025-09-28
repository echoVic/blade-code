export interface RouteConfig {
  path: string;
  component: string;
  title: string;
  icon?: string;
  guards?: ((targetView: string, options?: any) => boolean)[];
  sidebar?: boolean;
  footer?: boolean;
  meta?: Record<string, any>;
  onNavigate?: (view: string, options?: any) => void;
}