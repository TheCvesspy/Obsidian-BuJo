| **Engine**            | **What is ...**                     | **Licence**                           | **Primární usecase**                                                                    |
| --------------------- | ----------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| **Camunda 8 (Zeebe)** | BPM / Process Orchestration         | Apache 2.0 (OSS core) + komerční SaaS | Business procesy s human tasks, BPMN vizualizace, enterprise integrace                  |
| **Temporal**          | Durable Execution                   | MIT (server + SDK)                    | Long-running distribuované workflows, microservice orchestrace, fault-tolerant systémy  |
| **Restate**           | Durable Execution                   | MIT                                   | Jednoduchý self-hosted durable execution, event-driven handlers, single binary          |
| **Conductor OSS**     | Microservice Orchestration          | Apache 2.0                            | Orchestrace mikroslužeb, dynamic branching, language-agnostic workers                   |
| **Flowable**          | BPM / Case Management               | Apache 2.0 (OSS core) + komerční      | Human task management, BPMN + CMMN, case management s nepředvídatelným průběhem         |
| **Elsa Workflows**    | Embedded Workflow Engine            | Apache 2.0                            | .NET-native long-running workflows, embedded do ASP.NET aplikace bez externího clusteru |
| **Apache Airflow**    | DAG / Pipeline Orchestrator         | Apache 2.0                            | ETL, datové pipeline, ML workflows — nevhodný pro business process orchestraci          |
| **Dagster**           | Asset-centric Pipeline Orchestrator | Apache 2.0                            | Data engineering, ML pipelines, asset lineage — nevhodný pro business orchestraci       |
| **Prefect**           | Pipeline Orchestrator               | Apache 2.0 (OSS core)                 | Python-native data workflows, hybridní execution — nevhodný pro business orchestraci    |
| **Argo Workflows**    | Kubernetes-native DAG               | Apache 2.0                            | Paralelní joby na Kubernetes, CI/CD, ML pipelines — nevhodný pro                        |
