import { cn } from "@/lib/utils";

interface AvatarProps {
  src?: string | null;
  fallback: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}

const sizeStyles = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
};

export function Avatar({ src, fallback, className, size = "md" }: AvatarProps) {
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted",
        sizeStyles[size],
        className
      )}
    >
      {src ? (
        <img src={src} alt={fallback} className="h-full w-full object-cover" />
      ) : (
        <span className="font-medium text-muted-foreground">
          {fallback.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}
