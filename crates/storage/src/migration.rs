use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, TransactionBehavior, params};

use crate::StorageError;

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial",
        sql: include_str!("../migrations/0001_initial.sql"),
    },
    Migration {
        version: 2,
        name: "message_reasoning",
        sql: include_str!("../migrations/0002_message_reasoning.sql"),
    },
];

pub(crate) fn apply(connection: &mut Connection) -> Result<(), StorageError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (\
             version INTEGER PRIMARY KEY,\
             name TEXT NOT NULL,\
             applied_at INTEGER NOT NULL\
         ) STRICT;",
    )?;

    let mut statement =
        transaction.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC")?;
    let applied = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (index, (version, name)) in applied.iter().enumerate() {
        let Some(expected) = MIGRATIONS.get(index) else {
            return Err(StorageError::UnsupportedSchema(*version));
        };
        if *version != expected.version || name != expected.name {
            return Err(StorageError::MigrationMismatch(*version));
        }
    }
    let current = applied.last().map_or(0, |(version, _)| *version);

    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version > current)
    {
        transaction.execute_batch(migration.sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
            params![migration.version, migration.name, unix_milliseconds()?],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn unix_milliseconds() -> Result<i64, StorageError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StorageError::Clock)?;
    i64::try_from(duration.as_millis()).map_err(|_| StorageError::Clock)
}
