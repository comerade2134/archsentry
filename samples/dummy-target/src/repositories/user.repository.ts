import { db } from "../db";

export class UserRepository {
  async findByEmail(email: string) {
    // Allowed: data access lives in the repository layer.
    return db.query("SELECT * FROM users WHERE email = $1", [email]);
  }

  async create(user: { email: string; name: string }) {
    // Even raw SQL is fine here — this IS the repository layer.
    return db.query("INSERT INTO users (email, name) VALUES ($1, $2)", [user.email, user.name]);
  }
}
