import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/config";

export default function Home() {
  if (!isSetupComplete()) {
    redirect("/setup");
  }

  // Middleware handles session check — if we reach here, user is authenticated
  redirect("/chat");
}
