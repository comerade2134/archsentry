import { db } from "../db";
import { UserService } from "../services/user.service";

export class UserController {
  async register(payload: { email: string; name: string }) {
    // VIOLATION: direct DB write outside the repository layer.
    await db.query("INSERT INTO users (email, name) VALUES ($1, $2)", [payload.email, payload.name]);
    return UserService.welcome(payload.email);
  }
}
